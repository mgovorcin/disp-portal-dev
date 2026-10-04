"""disp-proxy: serve the ASF overview tiles with CORS, colourised or decoded.

The ASF tile host only allows the ASF portal origin, so a browser app on any other
origin (GeoLibre web/desktop) cannot load the tiles into WebGL. This service fetches
them server-side, caches them on disk, and exposes:

    GET  /tiles/{dir}/{kind}/{z}/{x}/{y}.png  RGBA, ASF colour ramp (z > 12 is cut from z12)
    GET  /raw/{dir}/{kind}/{z}/{x}/{y}.png    original encoded LA tile
    GET  /value?lon=&lat=&dir=&kind=          decoded value at zoom 12
    POST /sample   {points: [[lon, lat], ...]}             decoded values at points
    POST /profile  {line: GeoJSON LineString, step_m}      values along a line
    POST /stats    {geometry: GeoJSON Polygon, threshold}  zonal statistics at zoom 12
    POST /analyze  {features: [...], direction, threshold}  statistics for many points/lines/polygons
    GET  /extent/{dir}/{kind}                 ASF extent.json + tile date
    GET  /                                    GeoLibre (self-hosted build) or redirect to GeoLibre web
    GET  /deployment.json                     GeoLibre deployment policy (OPERA DISP on by default)
    GET  /viewer                              small MapLibre test viewer
    POST /jobs, GET /jobs[/{id}], POST /jobs/{id}/cancel, DELETE /jobs/{id}, GET /jobs/{id}/files/...
                                              download a DISP-S1 subset and prepare GeoZarr

The time-series API needs no proxy (it allows any origin).

Run: ``disp-proxy --port 8790`` (or ``uvicorn disp_portal.proxy:app``).
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
import mercantile
import numpy as np
import shapely
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field
from pyproj import Transformer
from shapely.geometry import shape

from disp_portal.asf import extent_url, normalize_direction, tile_url
from disp_portal.basemaps import BASEMAPS, style_json
from disp_portal.cubes import analyze_features as cube_analyze_features
from disp_portal.cubes import coverage as cube_coverage
from disp_portal.cubes import cube_timeseries, products_dir_for
from disp_portal.jobs import JobManager, JobRequest
from disp_portal.stats import line_lonlats as _line_lonlats
from disp_portal.stats import summarize as _summarize
from disp_portal.stats import to_web_mercator as _to_web_mercator
from disp_portal.tiles import (
    DEFAULT_SCALE,
    NATIVE_ZOOM,
    TILE_SIZE,
    UNITS,
    colorize,
    decode,
    lonlat_to_pixel,
    ramp_css_colors,
    read_png,
)

Kind = Literal["vel", "disp"]
DirParam = Literal["asc", "desc", "ascending", "descending"]

CACHE_DIR = Path(os.environ.get("DISP_PROXY_CACHE", Path(__file__).resolve().parents[2] / ".cache" / "tiles"))
ALLOWED_ORIGINS = os.environ.get("DISP_PROXY_ORIGINS", "*").split(",")
UPSTREAM_CONCURRENCY = int(os.environ.get("DISP_PROXY_CONCURRENCY", "8"))
MAX_STATS_TILES = int(os.environ.get("DISP_PROXY_MAX_STATS_TILES", "256"))
TILE_CACHE_CONTROL = "public, max-age=86400"

_to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)


def _empty_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


EMPTY_PNG = _empty_png()


class TileStore:
    """Async upstream fetch with a disk cache shared with :class:`disp_portal.tiles.TileFetcher`."""

    def __init__(self, cache_dir: Path, concurrency: int = UPSTREAM_CONCURRENCY):
        self.cache_dir = cache_dir
        self.client = httpx.AsyncClient(timeout=30.0, headers={"User-Agent": "disp-portal-proxy"})
        self.semaphore = asyncio.Semaphore(concurrency)
        self.extents: dict[tuple[str, str], dict] = {}

    async def close(self) -> None:
        await self.client.aclose()

    def _path(self, direction: str, kind: str, z: int, x: int, y: int) -> Path:
        return self.cache_dir / direction / kind / str(z) / str(x) / f"{y}.png"

    async def get_bytes(self, direction: str, kind: str, z: int, x: int, y: int) -> bytes | None:
        path = self._path(direction, kind, z, x, y)
        if path.exists():
            return path.read_bytes()
        if path.with_suffix(".missing").exists():
            return None
        async with self.semaphore:
            response = await self.client.get(tile_url(direction, kind, z, x, y))
        path.parent.mkdir(parents=True, exist_ok=True)
        if response.status_code in (403, 404):
            path.with_suffix(".missing").touch()
            return None
        if response.status_code != 200:
            raise HTTPException(502, f"ASF tile host returned {response.status_code}")
        path.write_bytes(response.content)
        return response.content

    async def get_array(self, direction: str, kind: str, z: int, x: int, y: int):
        content = await self.get_bytes(direction, kind, z, x, y)
        return None if content is None else read_png(content)

    async def extent(self, direction: str, kind: str) -> dict:
        key = (direction, kind)
        if key not in self.extents:
            response = await self.client.get(extent_url(direction, kind))
            if response.status_code != 200:
                raise HTTPException(502, f"ASF extent.json returned {response.status_code}")
            info = response.json()
            info["tile_date"] = response.headers.get("last-modified")
            self.extents[key] = info
        return self.extents[key]

    async def scale(self, direction: str, kind: str) -> tuple[float, float]:
        try:
            lo, hi = (await self.extent(direction, kind))["scale_range"]["range"]
            return float(lo), float(hi)
        except (HTTPException, KeyError, httpx.HTTPError):
            return DEFAULT_SCALE[kind]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = TileStore(CACHE_DIR)
    app.state.jobs = JobManager()

    async def tick_jobs():
        # Start queued download jobs when a runner slot frees up.
        while True:
            await asyncio.sleep(5)
            try:
                await asyncio.to_thread(app.state.jobs.tick)
            except OSError as e:
                print(f"job tick failed: {e}")

    ticker = asyncio.create_task(tick_jobs())
    yield
    ticker.cancel()
    await app.state.store.close()


app = FastAPI(title="disp-proxy", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def revalidate_plugin_files(request: Request, call_next):
    # The baked-in plugin is updated in place (build_geolibre.sh --plugin-only); make browsers
    # revalidate it so a reload always picks up the current version.
    response = await call_next(request)
    if request.url.path.startswith(("/plugins/", "/branding/")) or request.url.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    # Chrome asks public sites (e.g. https://web.geolibre.app) for permission before they
    # call a localhost service; answer the Private Network Access preflight.
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def _store(request: Request) -> TileStore:
    return request.app.state.store


def _dir(direction: str) -> str:
    try:
        return normalize_direction(direction)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


def _png(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(array, mode="RGBA" if array.ndim == 3 else "LA").save(buffer, format="PNG")
    return buffer.getvalue()


async def _native_or_parent(store: TileStore, direction: str, kind: str, z: int, x: int, y: int):
    """Encoded (byte, alpha) for a tile; above zoom 12, cut and enlarge the zoom-12 parent."""
    if z <= NATIVE_ZOOM:
        return await store.get_array(direction, kind, z, x, y)
    factor = 2 ** (z - NATIVE_ZOOM)
    parent = await store.get_array(direction, kind, NATIVE_ZOOM, x // factor, y // factor)
    if parent is None:
        return None
    size = TILE_SIZE // factor
    r0, c0 = (y % factor) * size, (x % factor) * size
    window = np.s_[r0 : r0 + size, c0 : c0 + size]
    byte = np.repeat(np.repeat(parent[0][window], factor, 0), factor, 1)
    alpha = None if parent[1] is None else np.repeat(np.repeat(parent[1][window], factor, 0), factor, 1)
    return byte, alpha


@app.get("/tiles/{direction}/{kind}/{z}/{x}/{y}.png")
async def tiles(request: Request, direction: DirParam, kind: Kind, z: int, x: int, y: int):
    if not 0 <= z <= 18:
        raise HTTPException(422, "zoom must be 0..18")
    tile = await _native_or_parent(_store(request), _dir(direction), kind, z, x, y)
    if tile is None:
        content = EMPTY_PNG
    else:
        content = _png(colorize(*tile))
    return Response(content, media_type="image/png", headers={"Cache-Control": TILE_CACHE_CONTROL})


@app.get("/raw/{direction}/{kind}/{z}/{x}/{y}.png")
async def raw(request: Request, direction: DirParam, kind: Kind, z: int, x: int, y: int):
    if z > NATIVE_ZOOM:
        tile = await _native_or_parent(_store(request), _dir(direction), kind, z, x, y)
        if tile is None:
            content = EMPTY_PNG
        else:
            byte, alpha = tile
            alpha = np.full_like(byte, 255) if alpha is None else alpha
            content = _png(np.dstack([byte, alpha]))
    else:
        content = await _store(request).get_bytes(_dir(direction), kind, z, x, y) or EMPTY_PNG
    return Response(content, media_type="image/png", headers={"Cache-Control": TILE_CACHE_CONTROL})


@app.get("/extent/{direction}/{kind}")
async def extent(request: Request, direction: DirParam, kind: Kind):
    info = dict(await _store(request).extent(_dir(direction), kind))
    lo, hi = info.get("scale_range", {}).get("range", DEFAULT_SCALE[kind])
    info["quantization"] = (hi - lo) / 254
    info["legend_colors"] = ramp_css_colors(10)
    return info


async def _values_at(store: TileStore, direction: str, kind: str, lonlats: np.ndarray) -> np.ndarray:
    """Decoded zoom-12 values at many (lon, lat) points, fetching each tile once."""
    scale = await store.scale(direction, kind)
    pixels = [lonlat_to_pixel(float(lon), float(lat), NATIVE_ZOOM) for lon, lat in lonlats]
    keys = sorted({(tx, ty) for tx, ty, _, _ in pixels})
    arrays = await asyncio.gather(*(store.get_array(direction, kind, NATIVE_ZOOM, tx, ty) for tx, ty in keys))
    by_key = dict(zip(keys, arrays))
    out = np.full(len(pixels), np.nan, dtype=np.float64)
    for i, (tx, ty, col, row) in enumerate(pixels):
        tile = by_key[(tx, ty)]
        if tile is None:
            continue
        byte, alpha = tile
        a = None if alpha is None else alpha[row : row + 1, col : col + 1]
        out[i] = decode(byte[row : row + 1, col : col + 1], a, scale)[0, 0]
    return out


def _clean(values: np.ndarray) -> list[float | None]:
    return [None if not np.isfinite(v) else round(float(v), 6) for v in values]


async def _meta(store: TileStore, direction: str, kind: str) -> dict:
    lo, hi = await store.scale(direction, kind)
    try:
        tile_date = (await store.extent(direction, kind)).get("tile_date")
    except HTTPException:
        tile_date = None
    return {
        "direction": direction,
        "kind": kind,
        "units": UNITS[kind],
        "zoom": NATIVE_ZOOM,
        "scale_range": [lo, hi],
        "quantization": (hi - lo) / 254,
        "tile_date": tile_date,
        "product": "ASF overview (OPERA-DISP-TMS): short-wavelength, quantized and clipped",
    }


@app.get("/value")
async def value(
    request: Request,
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-85.05, le=85.05),
    dir: DirParam = "asc",
    kind: Kind = "vel",
):
    store, direction = _store(request), _dir(dir)
    v = (await _values_at(store, direction, kind, np.array([[lon, lat]])))[0]
    meta = await _meta(store, direction, kind)
    lo, hi = meta["scale_range"]
    return {
        "lon": lon,
        "lat": lat,
        "value": _clean(np.array([v]))[0],
        "clipped": bool(np.isfinite(v) and (v <= lo + 1e-9 or v >= hi - 1e-9)),
        **meta,
    }


class SampleRequest(BaseModel):
    points: list[tuple[float, float]] = Field(..., min_length=1, max_length=10_000)
    direction: DirParam = "asc"
    kind: Kind = "vel"


@app.post("/sample")
async def sample(request: Request, body: SampleRequest):
    store, direction = _store(request), _dir(body.direction)
    values = await _values_at(store, direction, body.kind, np.asarray(body.points, dtype=float))
    return {"values": _clean(values), **(await _meta(store, direction, body.kind))}


class ProfileRequest(BaseModel):
    line: dict
    direction: DirParam = "asc"
    kind: Kind = "vel"
    step_m: float = Field(30.0, gt=0)
    max_points: int = Field(5000, gt=1, le=20_000)


@app.post("/profile")
async def profile(request: Request, body: ProfileRequest):
    geom = shape(body.line)
    if geom.geom_type not in ("LineString", "MultiLineString"):
        raise HTTPException(422, "line must be a GeoJSON LineString")
    lonlats, distances = _line_lonlats(geom, body.step_m, body.max_points)
    lons, lats = lonlats[:, 0], lonlats[:, 1]
    store, direction = _store(request), _dir(body.direction)
    values = await _values_at(store, direction, body.kind, np.column_stack([lons, lats]))
    return {
        "distance_m": [round(float(d), 1) for d in distances],
        "lon": [round(float(v), 6) for v in lons],
        "lat": [round(float(v), 6) for v in lats],
        "values": _clean(values),
        **(await _meta(store, direction, body.kind)),
    }


class StatsRequest(BaseModel):
    geometry: dict
    direction: DirParam = "asc"
    kind: Kind = "vel"
    threshold: float | None = Field(None, description="report the share of pixels below this value")


class TileMemo:
    """Per-request memo of decoded tiles, so features sharing tiles decode each tile once."""

    def __init__(self, store: TileStore, direction: str, kind: str, scale: tuple[float, float]):
        self.store, self.direction, self.kind, self.scale = store, direction, kind, scale
        self._tasks: dict[tuple[int, int], asyncio.Task] = {}

    async def _load(self, x: int, y: int) -> np.ndarray | None:
        tile = await self.store.get_array(self.direction, self.kind, NATIVE_ZOOM, x, y)
        return None if tile is None else decode(*tile, self.scale)

    async def values(self, x: int, y: int) -> np.ndarray | None:
        key = (x, y)
        if key not in self._tasks:
            self._tasks[key] = asyncio.ensure_future(self._load(x, y))
        return await self._tasks[key]


async def _polygon_values(memo: TileMemo, geom, max_tiles: int = MAX_STATS_TILES) -> tuple[np.ndarray, int]:
    """Valid decoded zoom-12 pixel values whose centres fall inside `geom`, and the pixel count."""
    tiles_needed = list(mercantile.tiles(*geom.bounds, zooms=NATIVE_ZOOM))
    if len(tiles_needed) > max_tiles:
        raise HTTPException(
            413, f"polygon needs {len(tiles_needed)} zoom-12 tiles (max {max_tiles}); use a smaller area"
        )
    geom_3857 = _to_web_mercator(geom)
    shapely.prepare(geom_3857)
    arrays = await asyncio.gather(*(memo.values(t.x, t.y) for t in tiles_needed))
    collected = []
    n_inside = 0
    for t, values in zip(tiles_needed, arrays):
        b = mercantile.xy_bounds(t)
        res = (b.right - b.left) / TILE_SIZE
        xs = b.left + res * (np.arange(TILE_SIZE) + 0.5)
        ys = b.top - res * (np.arange(TILE_SIZE) + 0.5)
        gx, gy = np.meshgrid(xs, ys)
        inside = shapely.contains_xy(geom_3857, gx, gy)
        n_inside += int(inside.sum())
        if values is None or not inside.any():
            continue
        picked = values[inside]
        collected.append(picked[np.isfinite(picked)])
    return (np.concatenate(collected) if collected else np.array([])), n_inside


async def _point_values(memo: TileMemo, lonlats: np.ndarray) -> np.ndarray:
    out = np.full(len(lonlats), np.nan)
    for i, (lon, lat) in enumerate(lonlats):
        tx, ty, col, row = lonlat_to_pixel(float(lon), float(lat), NATIVE_ZOOM)
        values = await memo.values(tx, ty)
        if values is not None:
            out[i] = values[row, col]
    return out


@app.post("/stats")
async def stats(request: Request, body: StatsRequest):
    geom = shape(body.geometry)
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise HTTPException(422, "geometry must be a GeoJSON Polygon or MultiPolygon")
    store, direction = _store(request), _dir(body.direction)
    scale = await store.scale(direction, body.kind)
    values, n_inside = await _polygon_values(TileMemo(store, direction, body.kind, scale), geom)
    result = _summarize(values, n_inside, scale, body.threshold)
    return {**result, "threshold": body.threshold, **(await _meta(store, direction, body.kind))}


MAX_ANALYZE_FEATURES = int(os.environ.get("DISP_PROXY_MAX_ANALYZE_FEATURES", "5000"))


class AnalyzeRequest(BaseModel):
    features: list[dict] = Field(..., min_length=1, description="GeoJSON features (or bare geometries)")
    direction: DirParam = "asc"
    kind: Kind = "vel"
    threshold: float | None = Field(None, description="report the share of values below this value")
    abs_threshold: float | None = Field(None, ge=0, description="report the share of values with |v| >= this")
    step_m: float = Field(30.0, gt=0, description="sampling step along lines")
    max_line_points: int = Field(2000, gt=1, le=20_000)


async def _analyze_feature(memo: TileMemo, feature: dict, body: AnalyzeRequest) -> dict:
    raw = feature.get("geometry", feature) if feature.get("type") == "Feature" else feature
    if not raw:
        return {"error": "no geometry"}
    try:
        geom = shape(raw)
    except (ValueError, TypeError, AttributeError) as e:
        return {"error": f"invalid geometry: {e}"}
    kind = geom.geom_type
    try:
        if kind in ("Polygon", "MultiPolygon"):
            values, n_total = await _polygon_values(memo, geom)
        elif kind in ("Point", "MultiPoint"):
            points = [geom] if kind == "Point" else list(geom.geoms)
            values = await _point_values(memo, np.array([[p.x, p.y] for p in points]))
            n_total = len(points)
        elif kind in ("LineString", "MultiLineString"):
            lonlats, _ = _line_lonlats(geom, body.step_m, body.max_line_points)
            values = await _point_values(memo, lonlats)
            n_total = len(lonlats)
        else:
            return {"geometry_type": kind, "error": f"unsupported geometry {kind}"}
    except HTTPException as e:
        return {"geometry_type": kind, "error": str(e.detail)}
    return {"geometry_type": kind, **_summarize(values, n_total, memo.scale, body.threshold, body.abs_threshold)}


@app.post("/analyze")
async def analyze(request: Request, body: AnalyzeRequest):
    """Velocity statistics for many features at once (points, lines and polygons).

    Points: the pixel value (n = number of points); lines: values sampled every `step_m`;
    polygons: all zoom-12 pixels inside. Results are in input order, in m/yr.
    """
    if len(body.features) > MAX_ANALYZE_FEATURES:
        raise HTTPException(413, f"{len(body.features)} features (max {MAX_ANALYZE_FEATURES})")
    store, direction = _store(request), _dir(body.direction)
    scale = await store.scale(direction, body.kind)
    memo = TileMemo(store, direction, body.kind, scale)
    results = [await _analyze_feature(memo, f, body) for f in body.features]
    return {
        "results": results,
        "threshold": body.threshold,
        "tiles_read": len(memo._tasks),
        **(await _meta(store, direction, body.kind)),
    }


# ── download + prepare jobs (Phase 1e) ─────────────────────────────────


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@app.post("/jobs", status_code=201)
async def create_job(request: Request, body: JobRequest):
    """Download a DISP-S1 subset for an area and prepare GeoZarr cubes (runs in the background)."""
    try:
        return await asyncio.to_thread(_jobs(request).create, body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@app.get("/jobs")
async def list_jobs(request: Request):
    return await asyncio.to_thread(_jobs(request).list)


@app.get("/jobs-usage")
async def jobs_usage(request: Request):
    """Disk used by download jobs and the clean-up limits."""
    return await asyncio.to_thread(_jobs(request).usage)


@app.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: str, log: int = Query(40, ge=0, le=1000)):
    try:
        return await asyncio.to_thread(_jobs(request).record, job_id, log)
    except KeyError as e:
        raise HTTPException(404, f"no job {job_id}") from e


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(request: Request, job_id: str):
    try:
        return await asyncio.to_thread(_jobs(request).cancel, job_id)
    except KeyError as e:
        raise HTTPException(404, f"no job {job_id}") from e


@app.delete("/jobs/{job_id}", status_code=204)
async def delete_job(request: Request, job_id: str):
    try:
        await asyncio.to_thread(_jobs(request).delete, job_id)
    except KeyError as e:
        raise HTTPException(404, f"no job {job_id}") from e
    return Response(status_code=204)


@app.get("/jobs/{job_id}/files/{path:path}")
async def job_file(request: Request, job_id: str, path: str):
    """Files of a job (GeoZarr stores are read chunk by chunk from here)."""
    try:
        target = _jobs(request).file_path(job_id, path)
    except KeyError as e:
        raise HTTPException(404, f"{path} not found in job {job_id}") from e
    media = "application/json" if target.name.endswith(".json") else "application/octet-stream"
    return FileResponse(target, media_type=media)


# ── time series from downloaded cubes (Phase 2) ─────────────────────────


class CubeTimeseriesRequest(BaseModel):
    geometry: dict | None = Field(None, description="GeoJSON Point/Polygon/MultiPolygon (lon/lat)")
    lon: float | None = None
    lat: float | None = None
    directions: list[DirParam] | None = None


@app.post("/cubes/timeseries")
async def cubes_timeseries(request: Request, body: CubeTimeseriesRequest):
    """Full and short-wavelength displacement series from downloaded GeoZarr cubes covering the
    geometry (point: nearest pixel; polygon: mean). Empty list when no cube covers it."""
    if body.geometry is not None:
        geom = shape(body.geometry)
    elif body.lon is not None and body.lat is not None:
        geom = shapely.Point(body.lon, body.lat)
    else:
        raise HTTPException(422, "give geometry or lon/lat")
    if geom.geom_type not in ("Point", "Polygon", "MultiPolygon"):
        raise HTTPException(422, "geometry must be a Point, Polygon or MultiPolygon")
    directions = (
        sorted({"asc" if _dir(d) == "ascending" else "desc" for d in body.directions}) if body.directions else None
    )
    try:
        series = await asyncio.to_thread(cube_timeseries, _jobs(request).root, geom, directions)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {"series": series}


class CubeAnalyzeRequest(BaseModel):
    features: list[dict] = Field(..., min_length=1)
    direction: DirParam = "asc"
    abs_threshold: float | None = Field(None, ge=0)
    step_m: float = Field(30.0, gt=0)
    max_line_points: int = Field(2000, gt=1, le=20_000)


@app.post("/cubes/analyze")
async def cubes_analyze(request: Request, body: CubeAnalyzeRequest):
    """Like /analyze but from downloaded cubes: float velocity (full displacement fit), with σ."""
    if len(body.features) > MAX_ANALYZE_FEATURES:
        raise HTTPException(413, f"{len(body.features)} features (max {MAX_ANALYZE_FEATURES})")
    direction = "asc" if _dir(body.direction) == "ascending" else "desc"
    results = await asyncio.to_thread(
        cube_analyze_features,
        _jobs(request).root,
        body.features,
        direction,
        abs_threshold=body.abs_threshold,
        step_m=body.step_m,
        max_line_points=body.max_line_points,
    )
    return {"results": results, "units": "m/yr", "source": "downloaded cubes", "direction": direction}


@app.get("/cubes/coverage")
async def cubes_coverage(request: Request):
    return await asyncio.to_thread(cube_coverage, _jobs(request).root)


# ── whole-frame velocity products (Phase 2, disp_portal.products) ─────────


def _products_listing(products_dir: Path) -> dict:
    frames = []
    for state_path in sorted((products_dir / "frames").glob("F*/frame.json")):
        try:
            st = json.loads(state_path.read_text())
        except (OSError, ValueError):
            continue
        rel = state_path.parent.relative_to(products_dir)
        frames.append({
            "frame": st.get("frame"),
            "direction": st.get("direction"),
            "state": st.get("state"),
            "step": st.get("step"),
            "error": st.get("error"),
            "elapsed_s": st.get("elapsed_s"),
            "n_granules": st.get("n_granules"),
            "time_range": (st.get("cube_90m") or {}).get("time_range"),
            "velocity_median_m_yr": (st.get("cube_90m") or {}).get("velocity_median_m_yr"),
            "geotiffs": [{**g, "path": f"{rel}/{g['path']}"} for g in st.get("geotiffs", [])],
            "cubes": [f"{rel}/{Path(st[k]['path']).name}" for k in ("cube_30m", "cube_90m") if st.get(k)],
        })
    catalogs = {}
    for cat in products_dir.glob("catalog_*.json"):
        try:
            c = json.loads(cat.read_text())
            catalogs[c["region"]] = {k: c[k] for k in ("n_frames", "n_with_products", "created")}
        except (OSError, ValueError, KeyError):
            continue
    return {"frames": frames, "catalogs": catalogs}


@app.get("/products")
async def products_list(request: Request):
    """Processed whole frames (state, COGs, cubes) and the region catalogues."""
    products_dir = products_dir_for(_jobs(request).root)
    if not products_dir.is_dir():
        return {"frames": [], "catalogs": {}}
    return await asyncio.to_thread(_products_listing, products_dir)


@app.get("/products/files/{path:path}")
async def products_file(request: Request, path: str):
    """Files of the whole-frame products (COGs, GeoZarr chunks)."""
    root = products_dir_for(_jobs(request).root).resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root / "frames") or not target.is_file():
        raise HTTPException(404, f"{path} not found")
    media = "application/json" if target.name.endswith(".json") else "application/octet-stream"
    return FileResponse(target, media_type=media)


@app.get("/health")
async def health():
    return {"status": "ok", "cache_dir": str(CACHE_DIR)}


@app.get("/basemaps")
async def basemaps_list(request: Request):
    base = str(request.base_url).rstrip("/")
    return [
        {
            "key": key,
            "name": b["name"],
            "attribution": b["attribution"],
            "maxzoom": b["maxzoom"],
            "tiles": b["tiles"],
            "labels": b.get("labels"),
            "style_url": f"{base}/basemaps/{key}.json",
        }
        for key, b in BASEMAPS.items()
    ]


@app.get("/basemaps/{key}.json")
async def basemap_style(key: str):
    if key not in BASEMAPS:
        raise HTTPException(404, f"unknown basemap {key!r}; one of {sorted(BASEMAPS)}")
    return style_json(key)


PLUGIN_ID = "opera-disp"
DEMO_GEOJSON = Path(__file__).parent / "data" / "demo_houston.geojson"


def _demo_layer() -> dict:
    return {
        "id": "opera-disp-demo-houston",
        "name": "Houston demo features",
        "type": "geojson",
        "source": {"type": "geojson"},
        "visible": True,
        "opacity": 1,
        "style": {"fillColor": "#f59e0b", "strokeColor": "#b45309", "strokeWidth": 2, "fillOpacity": 0.15, "circleRadius": 6},
        "metadata": {},
        "geojson": json.loads(DEMO_GEOJSON.read_text()),
    }


DEMO_DIR = Path(__file__).resolve().parents[2] / "demo"


@app.get("/demo/{name}")
async def demo_project(request: Request, name: str):
    """Demo GeoLibre projects (scripts/build_demo_project.py), with this server's origin filled in.
    Open as ``/?url=<origin>/demo/context-layers.geolibre``."""
    path = (DEMO_DIR / name).resolve()
    if path.parent != DEMO_DIR.resolve() or path.suffix != ".geolibre" or not path.is_file():
        raise HTTPException(404, f"no demo {name}")
    base = str(request.base_url).rstrip("/")
    text = path.read_text().replace("__BASE__", base)
    return Response(text, media_type="application/json", headers={"Cache-Control": "no-cache"})


@app.get("/project.json")
async def project(
    request: Request,
    lon: float = -95.4,
    lat: float = 29.8,
    z: float = 8,
    basemap: str = "light",
    dir: DirParam = "asc",
    demo: bool = False,
):
    """A GeoLibre project that loads the plugin from this proxy.

    ``demo=1`` adds a small Houston layer (areas, wells, a transect) for trying the analysis.

    Open ``https://web.geolibre.app/?url=<this proxy>/project.json``.
    """
    base = str(request.base_url).rstrip("/")
    basemap = basemap if basemap in BASEMAPS else "light"
    return JSONResponse(
        {
            "version": "0.1.0",
            "name": "OPERA DISP velocity (ASF overview)",
            "mapView": {"center": [lon, lat], "zoom": z, "bearing": 0, "pitch": 0},
            "basemapStyleUrl": f"{base}/basemaps/{basemap}.json",
            "basemapVisible": True,
            "basemapOpacity": 1,
            "layers": [_demo_layer()] if demo else [],
            # Open GeoLibre's place search panel with the project.
            "interaction": {"controls": {"search": True}},
            "styles": {},
            "plugins": {
                # The self-hosted build has the plugin baked in; only GeoLibre web needs the manifest.
                "manifestUrls": [] if _self_hosted() else [f"{base}/plugin/plugin.json"],
                "activePluginIds": [PLUGIN_ID, "maplibre-gl-annotations"],
                "settings": {
                    PLUGIN_ID: {
                        "proxyUrl": base,
                        "direction": "asc" if _dir(dir) == "ascending" else "desc",
                        "basemap": basemap,
                    }
                },
            },
        },
        headers={"Cache-Control": "no-store"},
    )


PLUGIN_DIR = Path(
    os.environ.get("DISP_PROXY_PLUGIN_DIR", Path(__file__).resolve().parents[2] / "plugin" / "geolibre-plugin")
)


@app.get("/plugin/{path:path}")
async def plugin_files(path: str):
    """Serve the built GeoLibre plugin bundle (plugin.json, dist/index.js, dist/style.css)."""
    target = (PLUGIN_DIR / path).resolve()
    if PLUGIN_DIR.resolve() not in target.parents or not target.is_file():
        raise HTTPException(404, f"{path} not found; build the plugin first (cd plugin && npm run build)")
    media_types = {".json": "application/json", ".js": "text/javascript", ".css": "text/css"}
    media = media_types.get(target.suffix, "application/octet-stream")
    return Response(target.read_bytes(), media_type=media, headers={"Cache-Control": "no-store"})


def _viewer_html() -> str:
    return (Path(__file__).parent / "viewer.html").read_text()


GEOLIBRE_WEB = os.environ.get("DISP_PROXY_GEOLIBRE", "https://web.geolibre.app")
# A GeoLibre web build with the plugin baked in (scripts/build_geolibre.sh). When present the
# proxy serves GeoLibre itself, so the plugin is always loaded and everything is same-origin.
GEOLIBRE_DIST = Path(
    os.environ.get("DISP_PROXY_GEOLIBRE_DIST", Path(__file__).resolve().parents[2] / "geolibre-web")
)


def _self_hosted() -> bool:
    return (GEOLIBRE_DIST / "index.html").is_file()


@app.get("/")
async def open_geolibre(request: Request):
    """GeoLibre with OPERA DISP.

    Self-hosted build present: serve it (view options such as lon, lat, z, basemap, dir, demo
    go through /project.json). Otherwise redirect to GeoLibre web with this proxy's project.
    """
    base = str(request.base_url).rstrip("/")
    query = request.url.query
    if _self_hosted():
        if not query or "url" in request.query_params:
            return FileResponse(GEOLIBRE_DIST / "index.html", headers={"Cache-Control": "no-cache"})
        return RedirectResponse(f"/?url={quote(f'{base}/project.json?{query}', safe=':/')}", status_code=307)
    project = f"{base}/project.json"
    if query:
        project += f"?{query}"
    return RedirectResponse(f"{GEOLIBRE_WEB}/?url={quote(project, safe=':/')}", status_code=307)


# GeoLibre's PWA service worker answers navigations from its cache, so query options such as
# /?demo=1 never reach this server. Locally there is no need for offline caching: replace it with
# a worker that unregisters itself and clears its caches.
KILL_SWITCH_SW = """
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
"""


@app.get("/sw.js")
async def service_worker():
    return Response(KILL_SWITCH_SW, media_type="text/javascript", headers={"Cache-Control": "no-store"})


@app.get("/deployment.json")
async def deployment_policy():
    """GeoLibre deployment policy for the self-hosted build: OPERA DISP on by default."""
    return JSONResponse(
        {
            "version": 1,
            "plugins": {"defaultActive": [PLUGIN_ID, "maplibre-gl-annotations"]},
            "branding": {"appName": "OPERA DISP Portal", "welcome": False},
        },
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/viewer", response_class=HTMLResponse)
async def viewer():
    # The viewer changes while we iterate; never let the browser keep an old copy.
    return HTMLResponse(_viewer_html(), headers={"Cache-Control": "no-store"})


@app.exception_handler(httpx.HTTPError)
async def upstream_error(request: Request, exc: httpx.HTTPError):
    return JSONResponse({"detail": f"upstream error: {exc}"}, status_code=502)


if _self_hosted():
    # Registered last so every API route above takes precedence over GeoLibre's static files.
    app.mount("/", StaticFiles(directory=GEOLIBRE_DIST, html=True), name="geolibre")


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Serve ASF overview tiles with CORS")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run("disp_portal.proxy:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()

"""Time series from downloaded GeoZarr cubes (Phase 2: our own time-series source).

The ASF service only gives short-wavelength displacement. Cubes prepared by
:mod:`disp_portal.prepare` hold the full ``displacement`` (re-referenced, with the chosen
corrections) and ``short_wavelength_displacement``; this module finds the cubes covering a
point or polygon and reads their series from level 0.
"""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import shapely
import xarray as xr
import zarr
from affine import Affine
from pyproj import Transformer
from shapely.geometry.base import BaseGeometry

MAX_POLYGON_PIXELS = 250_000


@dataclass(frozen=True)
class CubeInfo:
    job_id: str
    frame: int
    direction: str
    path: Path  # .../out/Fxxxxx_dir.zarr
    rel: str  # path relative to the job dir
    crs: str
    transform: tuple[float, ...]
    shape: tuple[int, int]
    footprint: BaseGeometry  # lon/lat polygon
    corrections: dict
    time_range: tuple[str, str]


@lru_cache(maxsize=256)
def _cube_info(path: str, mtime: float, job_id: str, frame: int, direction: str, rel: str) -> CubeInfo:
    root = dict(zarr.open_group(path, mode="r").attrs)
    level = dict(zarr.open_group(f"{path}/0", mode="r").attrs)
    crs = level["proj:code"]
    w, s, e, n = level["spatial:bbox"]
    to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    # Densify the projected box edges so the lon/lat footprint follows the UTM grid.
    xs = np.concatenate([np.linspace(w, e, 20), np.full(20, e), np.linspace(e, w, 20), np.full(20, w)])
    ys = np.concatenate([np.full(20, s), np.linspace(s, n, 20), np.full(20, n), np.linspace(n, s, 20)])
    lon, lat = to_ll.transform(xs, ys)
    footprint = shapely.Polygon(np.column_stack([lon, lat]))
    return CubeInfo(
        job_id=job_id,
        frame=frame,
        direction=direction,
        path=Path(path),
        rel=rel,
        crs=crs,
        transform=tuple(level["spatial:transform"][:6]),
        shape=tuple(level["spatial:shape"]),
        footprint=footprint,
        corrections=root.get("corrections", {}),
        time_range=tuple(root.get("time_range", ["", ""])),
    )


PRODUCTS_JOB_ID = "products"


def products_dir_for(jobs_dir: Path) -> Path:
    """Whole-frame products (:mod:`disp_portal.products`) live next to the jobs folder."""
    import os

    return Path(os.environ.get("DISP_PRODUCTS_DIR", jobs_dir.parent / "products"))


def _product_cubes(products_dir: Path) -> list[CubeInfo]:
    """Finished whole-frame products: the 30 m cube when present, else the 90 m one."""
    cubes: list[CubeInfo] = []
    for state_path in sorted((products_dir / "frames").glob("F*/frame.json")):
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            continue
        if state.get("state") != "done":
            continue
        for key in ("cube_30m", "cube_90m"):
            name = Path((state.get(key) or {}).get("path", "")).name  # stored path may be relative
            path = state_path.parent / name
            if name and (path / "0" / "zarr.json").is_file():
                rel = str(path.relative_to(products_dir))
                cubes.append(_cube_info(str(path), path.stat().st_mtime, PRODUCTS_JOB_ID, int(state["frame"]),
                                        state["direction"], rel))
                break
    return cubes


def list_cubes(jobs_dir: Path, products: bool = True) -> list[CubeInfo]:
    """All finished cubes in all jobs (newest job first), then the whole-frame products."""
    cubes: list[CubeInfo] = []
    for job_dir in sorted(jobs_dir.iterdir(), reverse=True):
        status_path = job_dir / "status.json"
        if not status_path.is_file():
            continue
        try:
            status = json.loads(status_path.read_text())
        except ValueError:
            continue
        for f in status.get("frames", []):
            rel = f.get("cube")
            if f.get("state") != "done" or not rel:
                continue
            path = job_dir / rel
            if not (path / "0" / "zarr.json").is_file():
                continue
            cubes.append(
                _cube_info(str(path), path.stat().st_mtime, job_dir.name, int(f["frame"]), f["direction"], rel)
            )
    if products and products_dir_for(jobs_dir).is_dir():
        cubes += _product_cubes(products_dir_for(jobs_dir))
    return cubes


def _pixel_mask(info: CubeInfo, geom_ll: BaseGeometry) -> tuple[slice, slice, np.ndarray] | None:
    """Row/col window and boolean mask of level-0 pixels whose centres fall in `geom_ll`."""
    to_xy = Transformer.from_crs("EPSG:4326", info.crs, always_xy=True)
    geom = shapely.transform(geom_ll, lambda c: np.column_stack(to_xy.transform(c[:, 0], c[:, 1])))
    t = Affine(*info.transform)
    inv = ~t
    minx, miny, maxx, maxy = geom.bounds
    cols = sorted(int(np.floor(c)) for c, _ in (inv * (minx, maxy), inv * (maxx, miny)))
    rows = sorted(int(np.floor(r)) for _, r in (inv * (minx, maxy), inv * (maxx, miny)))
    ny, nx = info.shape
    r0, r1 = max(rows[0], 0), min(rows[1] + 1, ny)
    c0, c1 = max(cols[0], 0), min(cols[1] + 1, nx)
    if r0 >= r1 or c0 >= c1:
        return None
    if geom.geom_type == "Point":
        col, row = inv * (geom.x, geom.y)
        row, col = int(np.floor(row)), int(np.floor(col))
        if not (0 <= row < ny and 0 <= col < nx):
            return None
        return slice(row, row + 1), slice(col, col + 1), np.ones((1, 1), bool)
    if (r1 - r0) * (c1 - c0) > MAX_POLYGON_PIXELS:
        raise ValueError(f"polygon covers {(r1 - r0) * (c1 - c0):,} pixels (max {MAX_POLYGON_PIXELS:,})")
    xs = t.c + t.a * (np.arange(c0, c1) + 0.5)
    ys = t.f + t.e * (np.arange(r0, r1) + 0.5)
    gx, gy = np.meshgrid(xs, ys)
    shapely.prepare(geom)
    mask = shapely.contains_xy(geom, gx, gy)
    if not mask.any():
        return None
    return slice(r0, r1), slice(c0, c1), mask


def _series(da: xr.DataArray, rows: slice, cols: slice, mask: np.ndarray) -> list[float | None]:
    block = np.asarray(da.isel(y=rows, x=cols).values, dtype=np.float64)  # (time, ny, nx)
    vals = np.where(mask[None], block, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN epochs -> NaN
        mean = np.nanmean(vals.reshape(vals.shape[0], -1), axis=1)
    return [None if not np.isfinite(v) else round(float(v), 6) for v in mean]


def _static(da: xr.DataArray, rows: slice, cols: slice, mask: np.ndarray) -> float | None:
    block = np.asarray(da.isel(y=rows, x=cols).values, dtype=np.float64)
    vals = block[mask]
    vals = vals[np.isfinite(vals)]
    return round(float(vals.mean()), 6) if vals.size else None


def cube_timeseries(jobs_dir: Path, geom_ll: BaseGeometry, directions: list[str] | None = None) -> list[dict]:
    """Series from every finished cube covering `geom_ll` (point: nearest pixel, polygon: mean)."""
    out: list[dict] = []
    probe = geom_ll if geom_ll.geom_type != "Point" else geom_ll.buffer(1e-9)
    seen: set[tuple] = set()
    for info in list_cubes(jobs_dir):  # newest job first
        if directions and info.direction not in directions:
            continue
        # The same frame/direction/dates/corrections downloaded twice: keep the newest only.
        key = (info.frame, info.direction, info.time_range, json.dumps(info.corrections, sort_keys=True))
        if key in seen:
            continue
        if not info.footprint.intersects(probe):
            continue
        window = _pixel_mask(info, geom_ll)
        if window is None:
            continue
        rows, cols, mask = window
        ds = xr.open_zarr(info.path, group="0", consolidated=False)
        times = [str(np.datetime_as_string(t, unit="s")) for t in ds.time.values]
        refs = (
            [str(np.datetime_as_string(t, unit="s")) for t in ds.reference_time.values]
            if "reference_time" in ds.coords
            else [None] * len(times)
        )
        series = {v: _series(ds[v], rows, cols, mask) for v in ("displacement", "short_wavelength_displacement") if v in ds}
        if not any(x is not None for x in series.get("displacement", [])):
            continue
        seen.add(key)
        out.append(
            {
                "job_id": info.job_id,
                "frame": info.frame,
                "direction": info.direction,
                "cube": info.rel,
                "crs": info.crs,
                "n_pixels": int(mask.sum()),
                "corrections": info.corrections,
                "time": times,
                "reference_time": refs,
                **series,
                "velocity": _static(ds["velocity"], rows, cols, mask) if "velocity" in ds else None,
                "velocity_stderr": _static(ds["velocity_stderr"], rows, cols, mask) if "velocity_stderr" in ds else None,
                "coherence": _static(ds["average_temporal_coherence"], rows, cols, mask)
                if "average_temporal_coherence" in ds
                else None,
            }
        )
    return out


def coverage(jobs_dir: Path) -> dict:
    """GeoJSON of all cube footprints (for showing where local data exists)."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "job_id": c.job_id,
                    "frame": c.frame,
                    "direction": c.direction,
                    "cube": c.rel,
                    "time_range": list(c.time_range),
                },
                "geometry": shapely.geometry.mapping(c.footprint),
            }
            for c in list_cubes(jobs_dir)
        ],
    }



def _cube_arrays(info: CubeInfo, cache: dict) -> dict[str, np.ndarray]:
    """Level-0 velocity / stderr arrays of a cube, loaded once per request."""
    key = str(info.path)
    if key not in cache:
        ds = xr.open_zarr(info.path, group="0", consolidated=False)
        cache[key] = {
            name: np.asarray(ds[name].values, dtype=np.float64)
            for name in ("velocity", "velocity_stderr")
            if name in ds
        } | {"n_epochs": int(ds.sizes["time"])}
    return cache[key]


def _choose_cube(cubes: list[CubeInfo], geom_ll: BaseGeometry) -> CubeInfo | None:
    """Newest cube containing the feature's centre, else the newest one intersecting it."""
    centre = geom_ll.representative_point()
    probe = geom_ll if geom_ll.geom_type not in ("Point", "MultiPoint") else geom_ll.buffer(1e-9)
    hits = [c for c in cubes if c.footprint.intersects(probe)]
    if not hits:
        return None
    return next((c for c in hits if c.footprint.contains(centre)), hits[0])


def analyze_features(
    jobs_dir: Path,
    features: list[dict],
    direction: str,
    *,
    abs_threshold: float | None = None,
    step_m: float = 30.0,
    max_line_points: int = 2000,
) -> list[dict]:
    """Velocity statistics (m/yr) of each feature from the downloaded cubes of one direction.

    Same result shape as disp-proxy ``/analyze`` (ASF tiles), plus ``stderr_median`` and the
    cube used. Float data: nothing is clipped or quantized.
    """
    from shapely.geometry import shape

    from disp_portal.stats import line_lonlats, summarize

    cubes = [c for c in list_cubes(jobs_dir) if c.direction == direction]
    cache: dict = {}
    out: list[dict] = []
    for feature in features:
        raw = feature.get("geometry", feature) if feature.get("type") == "Feature" else feature
        if not raw:
            out.append({"error": "no geometry"})
            continue
        try:
            geom = shape(raw)
        except (ValueError, TypeError, AttributeError) as e:
            out.append({"error": f"invalid geometry: {e}"})
            continue
        kind = geom.geom_type
        cube = _choose_cube(cubes, geom) if not geom.is_empty else None
        if cube is None:
            out.append({"geometry_type": kind, "error": f"no downloaded {direction} cube covers this feature"})
            continue
        arrays = _cube_arrays(cube, cache)
        try:
            if kind in ("Polygon", "MultiPolygon"):
                window = _pixel_mask(cube, geom)
                if window is None:
                    raise ValueError("no cube pixel inside the polygon")
                rows, cols, mask = window
                vel = arrays["velocity"][rows, cols][mask]
                std = arrays.get("velocity_stderr", np.full_like(arrays["velocity"], np.nan))[rows, cols][mask]
                n_total = int(mask.sum())
            else:
                if kind in ("Point", "MultiPoint"):
                    pts = [geom] if kind == "Point" else list(geom.geoms)
                    lonlats = [(p.x, p.y) for p in pts]
                elif kind in ("LineString", "MultiLineString"):
                    lonlats = [tuple(xy) for xy in line_lonlats(geom, step_m, max_line_points)[0]]
                else:
                    raise ValueError(f"unsupported geometry {kind}")
                vel_list, std_list = [], []
                for lon, lat in lonlats:
                    window = _pixel_mask(cube, shapely.Point(lon, lat))
                    if window is None:
                        vel_list.append(np.nan)
                        std_list.append(np.nan)
                        continue
                    r, c, _ = window
                    vel_list.append(arrays["velocity"][r, c].item())
                    std_list.append(arrays["velocity_stderr"][r, c].item() if "velocity_stderr" in arrays else np.nan)
                vel, std = np.array(vel_list), np.array(std_list)
                n_total = len(lonlats)
        except ValueError as e:
            out.append({"geometry_type": kind, "error": str(e)})
            continue
        result = summarize(vel, n_total, None, None, abs_threshold)
        finite_std = std[np.isfinite(std)]
        out.append(
            {
                "geometry_type": kind,
                **result,
                "stderr_median": float(np.median(finite_std)) if finite_std.size else None,
                "cube": {
                    "job_id": cube.job_id,
                    "frame": cube.frame,
                    "path": cube.rel,
                    "time_range": list(cube.time_range),
                    "n_epochs": arrays["n_epochs"],
                    "corrections": cube.corrections,
                },
            }
        )
    return out

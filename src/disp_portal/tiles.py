"""Decode ASF overview tiles back to physical values.

OPERA-DISP-TMS (``create_tile_map.py``) builds the tiles with
``gdal.Translate(scaleParams=[[lo, hi, 1, 255]], outputType=Byte)`` followed by
``gdal2tiles --xyz --zoom=2-12``. Each PNG is grayscale + alpha (mode ``LA``):

    value = lo + (byte - 1) * (hi - lo) / 254        alpha == 0 -> nodata

with ``(lo, hi) = (-0.03, 0.03)`` m/yr for velocity and ``(-0.25, 0.25)`` m for
cumulative displacement. Values were clipped to ``[lo, hi]`` before scaling, so the
end bytes mean "at least this much". Zoom 12 is the native level; lower zooms are
gdal2tiles overviews (resampled bytes).
"""

from __future__ import annotations

import io
import math
from functools import lru_cache
from pathlib import Path

import httpx
import mercantile
import numpy as np
import rioxarray  # noqa: F401  (registers the .rio accessor)
import xarray as xr
from PIL import Image

from disp_portal.asf import Kind, fetch_extent, normalize_direction, tile_url

NATIVE_ZOOM = 12
TILE_SIZE = 256
DEFAULT_SCALE = {"vel": (-0.03, 0.03), "disp": (-0.25, 0.25)}
UNITS = {"vel": "m/yr", "disp": "m"}

# Colour ramp copied from the ASF portal frontend: (byte position, RGB), interpolated linearly
# on ``band * 255`` (OpenLayers WebGL normalises bytes to 0..1).
ASF_COLOR_STOPS: list[tuple[int, tuple[int, int, int]]] = [
    (1, (0, 18, 97)),
    (29, (3, 62, 125)),
    (58, (30, 111, 157)),
    (86, (113, 168, 196)),
    (114, (201, 221, 231)),
    (143, (234, 206, 189)),
    (171, (211, 151, 116)),
    (199, (190, 101, 51)),
    (228, (139, 39, 6)),
    (256, (89, 0, 8)),
]


def decode(byte: np.ndarray, alpha: np.ndarray | None, scale: tuple[float, float]) -> np.ndarray:
    """Convert encoded bytes to float32 physical values (NaN where nodata)."""
    lo, hi = scale
    values = lo + (byte.astype(np.float32) - 1.0) * np.float32((hi - lo) / 254.0)
    nodata = byte == 0
    if alpha is not None:
        nodata |= alpha == 0
    values[nodata] = np.nan
    return values


def encode(values: np.ndarray, scale: tuple[float, float]) -> np.ndarray:
    """Inverse of :func:`decode` (used for tests and for writing compatible tiles)."""
    lo, hi = scale
    clipped = np.clip(values, lo, hi)
    byte = np.rint(1 + (clipped - lo) * 254.0 / (hi - lo))
    byte = np.where(np.isnan(values), 0, byte)
    return byte.astype(np.uint8)


def _color_lut() -> np.ndarray:
    """256 x 4 RGBA lookup table for byte values, matching the ASF portal ramp."""
    positions = np.array([p for p, _ in ASF_COLOR_STOPS], dtype=float)
    colors = np.array([c for _, c in ASF_COLOR_STOPS], dtype=float)
    lut = np.zeros((256, 4), dtype=np.uint8)
    idx = np.arange(256, dtype=float)
    for channel in range(3):
        lut[:, channel] = np.rint(np.interp(idx, positions, colors[:, channel]))
    lut[:, 3] = 255
    lut[0] = 0
    return lut


COLOR_LUT = _color_lut()


def colorize(byte: np.ndarray, alpha: np.ndarray | None = None) -> np.ndarray:
    """Encoded bytes -> RGBA uint8 image using the ASF ramp."""
    rgba = COLOR_LUT[byte]
    if alpha is not None:
        rgba[..., 3] = np.where(alpha == 0, 0, rgba[..., 3])
    return rgba


def ramp_css_colors(n: int = 10) -> list[str]:
    """Evenly spaced CSS colours along the ramp, for colourbars."""
    idx = np.linspace(1, 255, n).round().astype(int)
    return ["#{:02x}{:02x}{:02x}".format(*COLOR_LUT[i, :3]) for i in idx]


def read_png(content: bytes) -> tuple[np.ndarray, np.ndarray | None]:
    """Return ``(byte, alpha)`` arrays from an LA / L / RGBA PNG."""
    image = Image.open(io.BytesIO(content))
    array = np.asarray(image)
    if image.mode == "LA":
        return array[..., 0], array[..., 1]
    if image.mode == "L":
        return array, None
    if image.mode in ("RGBA", "RGB"):
        alpha = array[..., 3] if image.mode == "RGBA" else None
        return array[..., 0], alpha
    raise ValueError(f"Unexpected tile mode {image.mode}")


class TileFetcher:
    """Fetch ASF tiles with an on-disk cache. Missing tiles (403/404) are ``None``."""

    def __init__(self, cache_dir: str | Path | None = None, timeout: float = 30.0):
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.client = httpx.Client(timeout=timeout)

    def _cache_path(self, direction: str, kind: Kind, z: int, x: int, y: int) -> Path | None:
        if self.cache_dir is None:
            return None
        return self.cache_dir / normalize_direction(direction) / kind / str(z) / str(x) / f"{y}.png"

    def get_bytes(self, direction: str, kind: Kind, z: int, x: int, y: int) -> bytes | None:
        path = self._cache_path(direction, kind, z, x, y)
        if path is not None:
            if path.exists():
                return path.read_bytes()
            if path.with_suffix(".missing").exists():
                return None
        response = self.client.get(tile_url(direction, kind, z, x, y))
        if response.status_code in (403, 404):
            if path is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.with_suffix(".missing").touch()
            return None
        response.raise_for_status()
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(response.content)
        return response.content

    def get(
        self, direction: str, kind: Kind, z: int, x: int, y: int
    ) -> tuple[np.ndarray, np.ndarray | None] | None:
        content = self.get_bytes(direction, kind, z, x, y)
        return None if content is None else read_png(content)


@lru_cache(maxsize=8)
def scale_range(direction: str, kind: Kind) -> tuple[float, float]:
    """Byte scaling range from ``extent.json``; falls back to the OPERA-DISP-TMS constants."""
    try:
        lo, hi = fetch_extent(direction, kind)["scale_range"]["range"]
        return float(lo), float(hi)
    except (httpx.HTTPError, KeyError, ValueError):
        return DEFAULT_SCALE[kind]


def lonlat_to_pixel(lon: float, lat: float, z: int) -> tuple[int, int, int, int]:
    """Return ``(tile_x, tile_y, col, row)`` of the pixel containing ``lon, lat`` at zoom ``z``."""
    n = 2**z
    lat_r = math.radians(lat)
    fx = (lon + 180.0) / 360.0 * n
    fy = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    tx, ty = int(fx), int(fy)
    col = min(int((fx - tx) * TILE_SIZE), TILE_SIZE - 1)
    row = min(int((fy - ty) * TILE_SIZE), TILE_SIZE - 1)
    return tx, ty, col, row


def value_at(
    lon: float,
    lat: float,
    direction: str,
    kind: Kind = "vel",
    z: int = NATIVE_ZOOM,
    fetcher: TileFetcher | None = None,
) -> float:
    """Decoded overview value at a point (NaN outside coverage)."""
    fetcher = fetcher or TileFetcher()
    tx, ty, col, row = lonlat_to_pixel(lon, lat, z)
    tile = fetcher.get(direction, kind, z, tx, ty)
    if tile is None:
        return float("nan")
    byte, alpha = tile
    window = np.s_[row : row + 1, col : col + 1]
    scale = scale_range(normalize_direction(direction), kind)
    values = decode(byte[window], None if alpha is None else alpha[window], scale)
    return float(values[0, 0])


def mosaic(
    bbox: tuple[float, float, float, float],
    direction: str,
    kind: Kind = "vel",
    z: int = NATIVE_ZOOM,
    fetcher: TileFetcher | None = None,
    max_tiles: int = 400,
) -> xr.DataArray:
    """Decode the tiles covering ``bbox`` (west, south, east, north; WGS84) into an EPSG:3857 grid.

    The result covers whole tiles; coordinates are pixel centres in Web Mercator metres.
    """
    fetcher = fetcher or TileFetcher()
    direction = normalize_direction(direction)
    tiles = list(mercantile.tiles(*bbox, zooms=z))
    if len(tiles) > max_tiles:
        raise ValueError(f"{len(tiles)} tiles at z{z} exceeds max_tiles={max_tiles}; lower z")
    xs = sorted({t.x for t in tiles})
    ys = sorted({t.y for t in tiles})
    data = np.full((len(ys) * TILE_SIZE, len(xs) * TILE_SIZE), np.nan, dtype=np.float32)
    scale = scale_range(direction, kind)
    for t in tiles:
        tile = fetcher.get(direction, kind, z, t.x, t.y)
        if tile is None:
            continue
        byte, alpha = tile
        r0 = (t.y - ys[0]) * TILE_SIZE
        c0 = (t.x - xs[0]) * TILE_SIZE
        data[r0 : r0 + TILE_SIZE, c0 : c0 + TILE_SIZE] = decode(byte, alpha, scale)

    ul = mercantile.xy_bounds(xs[0], ys[0], z)
    res = (ul.right - ul.left) / TILE_SIZE
    x = ul.left + res * (np.arange(data.shape[1]) + 0.5)
    y = ul.top - res * (np.arange(data.shape[0]) + 0.5)
    da = xr.DataArray(
        data,
        dims=("y", "x"),
        coords={"y": y, "x": x},
        name="velocity" if kind == "vel" else "displacement",
        attrs={
            "units": UNITS[kind],
            "source": "ASF Displacement Portal overview tiles (OPERA-DISP-TMS)",
            "direction": direction,
            "zoom": z,
            "scale_range": scale,
            "quantization": (scale[1] - scale[0]) / 254,
        },
    )
    return da.rio.write_crs("EPSG:3857")

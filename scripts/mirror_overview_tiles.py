"""Mirror the ASF OPERA DISP-S1 velocity overview tiles for the static (GitHub Pages) site.

The ASF tiles do not send CORS headers for other sites, so a browser map cannot draw them
from GitHub Pages. This script fetches them server-side (as disp-proxy does), colours them
with the ASF ramp and writes WebP tiles (quality 90: ~1/3 of the ASF PNG size, visually the
same at map scale) plus a legend/extent JSON per direction:

    <out>/overview/{asc,desc}/vel/{z}/{x}/{y}.webp
    <out>/overview/{asc,desc}/extent.json

Zoom 2..10 (150 m pixels, ~0.55 GB for both directions; zoom 11 would need ~1.7 GB, over the
1 GB GitHub Pages limit). ``--format png`` writes paletted PNGs instead (lossless, ~3x larger).
Tiles already present in <out> are kept (CI caches them), missing ones are fetched.

Usage:
    python scripts/mirror_overview_tiles.py dist-pages [--max-zoom 10] [--format webp] [--refresh]
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import time
from pathlib import Path

import httpx
import mercantile
import numpy as np
from PIL import Image

from disp_portal.asf import extent_url, fetch_extent, tile_url
from disp_portal.tiles import COLOR_LUT, ramp_css_colors, read_png

DIRECTIONS = {"asc": "ascending", "desc": "descending"}
NORTH_AMERICA = (-170.0, 5.0, -50.0, 72.0)  # covers every OPERA DISP-S1 frame
MIN_ZOOM = 2


def webp(content: bytes, quality: int = 90) -> bytes:
    """ASF encoded tile -> RGBA WebP with the ASF ramp (lossy colour, exact transparency)."""
    byte, alpha = read_png(content)
    index = byte.astype(np.uint8)
    if alpha is not None:
        index = np.where(alpha == 0, 0, index).astype(np.uint8)
    rgba = COLOR_LUT[index].copy()
    rgba[..., 3] = np.where(index == 0, 0, 255)
    buffer = io.BytesIO()
    # method 4: ~8 ms per tile; method 6 is ~90x slower (~0.7 s per tile) for ~3 % smaller files.
    Image.fromarray(rgba, "RGBA").save(buffer, format="WEBP", quality=quality, method=4, alpha_quality=100)
    return buffer.getvalue()


def paletted(content: bytes) -> bytes:
    """ASF encoded tile (byte + alpha) -> paletted PNG with the ASF ramp; index 0 transparent."""
    byte, alpha = read_png(content)
    index = byte.astype(np.uint8)
    if alpha is not None:
        index = np.where(alpha == 0, 0, index).astype(np.uint8)
    image = Image.fromarray(index, mode="P")
    image.putpalette(COLOR_LUT[:, :3].reshape(-1).tolist())
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, transparency=0)
    return buffer.getvalue()


async def mirror_direction(
    client: httpx.AsyncClient, out: Path, short: str, max_zoom: int, refresh: bool, fmt: str = "webp"
) -> dict:
    sem = asyncio.Semaphore(32)
    root = out / "overview" / short / "vel"
    stats = {"fetched": 0, "kept": 0, "bytes": 0}

    async def get(tile: mercantile.Tile) -> mercantile.Tile | None:
        path = root / str(tile.z) / str(tile.x) / f"{tile.y}.{fmt}"
        if path.exists() and not refresh:
            stats["kept"] += 1
            stats["bytes"] += path.stat().st_size
            return tile
        async with sem:
            for attempt in range(4):
                try:
                    r = await client.get(tile_url(DIRECTIONS[short], "vel", tile.z, tile.x, tile.y))
                    break
                except httpx.HTTPError:
                    await asyncio.sleep(2 * (attempt + 1))
            else:
                return None
        if r.status_code != 200:
            return None
        # Encode off the event loop so downloads keep flowing.
        data = await asyncio.to_thread(webp if fmt == "webp" else paletted, r.content)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        stats["fetched"] += 1
        stats["bytes"] += len(data)
        return tile

    level = list(mercantile.tiles(*NORTH_AMERICA, MIN_ZOOM))
    counts = {}
    for z in range(MIN_ZOOM, max_zoom + 1):
        have = [t for t in await asyncio.gather(*(get(t) for t in level)) if t is not None]
        counts[z] = len(have)
        print(f"{short} z{z}: {len(have)} tiles", flush=True)
        level = [child for t in have for child in mercantile.children(t)]
    return {**stats, "tiles_per_zoom": counts}


def write_extent(out: Path, short: str, max_zoom: int, fmt: str = "webp") -> None:
    info = dict(fetch_extent(DIRECTIONS[short], "vel"))
    # Tile generation date, as disp-proxy reports it (Last-Modified of the extent file).
    info["tile_date"] = httpx.head(extent_url(DIRECTIONS[short], "vel"), timeout=60).headers.get("last-modified")
    lo, hi = info.get("scale_range", {}).get("range", [-0.03, 0.03])
    info["quantization"] = (hi - lo) / 254
    info["legend_colors"] = ramp_css_colors(10)
    info["mirror"] = {"max_zoom": max_zoom, "mirrored": time.strftime("%Y-%m-%d"), "format": fmt}
    (out / "overview" / short).mkdir(parents=True, exist_ok=True)
    (out / "overview" / short / "extent.json").write_text(json.dumps(info, indent=1))


async def main_async(out: Path, max_zoom: int, refresh: bool, fmt: str) -> None:
    async with httpx.AsyncClient(timeout=60) as client:
        for short in DIRECTIONS:
            write_extent(out, short, max_zoom, fmt)
            stats = await mirror_direction(client, out, short, max_zoom, refresh, fmt)
            print(f"{short}: fetched {stats['fetched']}, kept {stats['kept']}, {stats['bytes'] / 1e6:.0f} MB", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--max-zoom", type=int, default=10)
    parser.add_argument("--format", choices=["webp", "png"], default="webp")
    parser.add_argument("--refresh", action="store_true", help="re-download tiles already present")
    args = parser.parse_args()
    asyncio.run(main_async(args.out, args.max_zoom, args.refresh, args.format))


if __name__ == "__main__":
    main()

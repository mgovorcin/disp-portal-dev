"""Shared helpers for velocity statistics (ASF overview tiles and downloaded cubes)."""

from __future__ import annotations

import math

import numpy as np
import shapely
from pyproj import Transformer

_to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_from_3857 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def to_web_mercator(geom):
    return shapely.transform(geom, lambda xy: np.column_stack(_to_3857.transform(xy[:, 0], xy[:, 1])))


def line_lonlats(geom, step_m: float, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Points every `step_m` metres along a (multi)line, and their along-line distance in metres."""
    line_3857 = to_web_mercator(geom)
    cos_lat = math.cos(math.radians(geom.centroid.y))
    # Web Mercator lengths are stretched by 1/cos(lat); correct the sampling step locally.
    step = step_m / cos_lat
    n = min(max_points, max(2, int(line_3857.length / step) + 1))
    distances = np.linspace(0, line_3857.length, n)
    pts = [line_3857.interpolate(d) for d in distances]
    lons, lats = _from_3857.transform([p.x for p in pts], [p.y for p in pts])
    return np.column_stack([lons, lats]), distances * cos_lat


def summarize(
    values: np.ndarray,
    n_total: int,
    scale: tuple[float, float] | None,
    threshold: float | None,
    abs_threshold: float | None = None,
) -> dict:
    """n, mean, median, std, min, max, p5, p95 of the finite values (+ threshold fractions).

    `scale` is the clipping range of quantized products (ASF tiles); None for float data.
    """
    values = values[np.isfinite(values)]
    result: dict = {"n_pixels": n_total, "n_valid": int(values.size)}
    if values.size:
        result.update(
            {
                "mean": float(values.mean()),
                "median": float(np.median(values)),
                "std": float(values.std()),
                "min": float(values.min()),
                "max": float(values.max()),
                "p5": float(np.percentile(values, 5)),
                "p95": float(np.percentile(values, 95)),
            }
        )
        if scale is not None:
            lo, hi = scale
            result["fraction_clipped"] = float(np.mean((values <= lo + 1e-9) | (values >= hi - 1e-9)))
        if threshold is not None:
            result["fraction_below_threshold"] = float(np.mean(values < threshold))
        if abs_threshold is not None:
            result["fraction_abs_exceeding"] = float(np.mean(np.abs(values) >= abs_threshold))
    result["valid_fraction"] = result["n_valid"] / n_total if n_total else 0.0
    return result

"""Combine a job's per-frame cubes: merge overlapping frames and decompose asc/desc.

Runs in jobs-env after :mod:`disp_portal.prepare` has written the cubes and the
DISP-S1-STATIC line-of-sight layers. Everything is put on one grid (the job area in the
first cube's UTM zone, 30 m):

1. **Merge per direction.** Frames of one direction are aligned to the frame with most
   valid pixels by the median velocity difference in their overlap (each frame has its
   own spatial reference), then averaged with 1/σ² weights.
2. **Decompose.** Where ascending and descending velocities exist, solve per pixel

       v_asc  = e_asc  * v_east + u_asc  * v_up
       v_desc = e_desc * v_east + u_desc * v_up

   with (e, u) the east and up components of the ground-to-satellite unit vector. The
   north component is neglected: Sentinel-1's near-polar orbit makes the LOS almost
   insensitive to north-south motion (|n| ~ 0.1). σ is propagated from the velocity σ.

Outputs (COG, float32, NaN nodata, m/yr) under ``<job>/out/combined/``.
"""

from __future__ import annotations

import logging
import warnings
from pathlib import Path

import numpy as np
import rioxarray
import xarray as xr
import zarr
from affine import Affine
from pyproj import Transformer
from rasterio.enums import Resampling
from shapely import wkt as shapely_wkt

from disp_portal.export import _with_geo, _write

log = logging.getLogger("disp_portal.combine")

MIN_OVERLAP_PIXELS = 50
GRID_RES = 30.0


def target_grid(area_wkt: str, crs: str, res: float = GRID_RES) -> xr.DataArray:
    """An empty grid covering the job area in `crs` at `res` metres (template for reprojection)."""
    west, south, east, north = shapely_wkt.loads(area_wkt).bounds
    to_crs = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    # Densified bbox edges, so the projected extent follows the curved UTM lines.
    t = np.linspace(0, 1, 21)
    lon = np.concatenate([west + (east - west) * t, np.full(21, east), east - (east - west) * t, np.full(21, west)])
    lat = np.concatenate([np.full(21, south), south + (north - south) * t, np.full(21, north), north - (north - south) * t])
    xs, ys = to_crs.transform(lon, lat)
    x0, x1 = np.floor(min(xs) / res) * res, np.ceil(max(xs) / res) * res
    y0, y1 = np.floor(min(ys) / res) * res, np.ceil(max(ys) / res) * res
    nx, ny = round((x1 - x0) / res), round((y1 - y0) / res)
    x = x0 + res * (np.arange(nx) + 0.5)
    y = y1 - res * (np.arange(ny) + 0.5)
    grid = xr.DataArray(np.full((ny, nx), np.nan, np.float32), dims=("y", "x"), coords={"y": y, "x": x})
    return grid.rio.write_crs(crs).rio.write_transform(Affine(res, 0, x0, 0, -res, y1))


def _cube_layer(cube: Path, name: str) -> xr.DataArray:
    ds = xr.open_zarr(cube, group="0", consolidated=False)
    attrs = dict(zarr.open_group(cube / "0", mode="r").attrs)
    da = ds[name].load().astype(np.float32)
    return _with_geo(da, attrs["proj:code"], Affine(*attrs["spatial:transform"][:6]))


def _on_grid(da: xr.DataArray, grid: xr.DataArray, resampling=Resampling.bilinear) -> np.ndarray:
    out = da.rio.reproject_match(grid, resampling=resampling, nodata=np.nan)
    return np.asarray(out.values, dtype=np.float64)


def merge_direction(frames: list[dict]) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Merge per-frame (velocity, sigma) arrays already on the common grid.

    Returns merged velocity, merged sigma, and per-frame alignment info.
    """
    empty = [f for f in frames if not np.isfinite(f["velocity"]).any()]
    order = sorted((f for f in frames if f not in empty), key=lambda f: -np.isfinite(f["velocity"]).sum()) or empty[:1]
    base = order[0]
    info = [{"frame": base["frame"], "offset_m_yr": 0.0, "overlap_pixels": None, "role": "reference"}]
    info += [{"frame": f["frame"], "offset_m_yr": None, "overlap_pixels": 0, "role": "no valid pixels in area"}
             for f in empty if f is not base]
    aligned = [(base["velocity"], base["sigma"])]
    for f in order[1:]:
        ref = np.nanmean(np.stack([v for v, _ in aligned]), axis=0) if len(aligned) > 1 else aligned[0][0]
        both = np.isfinite(ref) & np.isfinite(f["velocity"])
        n = int(both.sum())
        offset = float(np.median(ref[both] - f["velocity"][both])) if n >= MIN_OVERLAP_PIXELS else 0.0
        info.append({"frame": f["frame"], "offset_m_yr": offset, "overlap_pixels": n,
                     "role": "aligned" if n >= MIN_OVERLAP_PIXELS else "not aligned (too little overlap)"})
        aligned.append((f["velocity"] + offset, f["sigma"]))
    v = np.stack([a for a, _ in aligned])
    s = np.stack([b for _, b in aligned])
    # Pixels without sigma get the median sigma of their frame, so they still count.
    for i in range(s.shape[0]):
        fill = np.nanmedian(s[i]) if np.isfinite(s[i]).any() else 1.0
        s[i] = np.where(np.isfinite(v[i]) & ~np.isfinite(s[i]), fill, s[i])
    w = np.where(np.isfinite(v) & np.isfinite(s) & (s > 0), 1.0 / np.maximum(s, 1e-6) ** 2, 0.0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        merged = np.where(wsum > 0, np.nansum(np.where(w > 0, v, 0.0) * w, axis=0) / wsum, np.nan)
        sigma = np.where(wsum > 0, 1.0 / np.sqrt(wsum), np.nan)
    return merged, sigma, info


def decompose(
    v_asc: np.ndarray, s_asc: np.ndarray, los_asc: np.ndarray,
    v_desc: np.ndarray, s_desc: np.ndarray, los_desc: np.ndarray,
    min_det: float = 0.2,
) -> dict[str, np.ndarray]:
    """East and vertical velocity (and σ) from asc/desc LOS velocity; los_* are (3, y, x) ENU."""
    ea, ua = los_asc[0], los_asc[2]
    ed, ud = los_desc[0], los_desc[2]
    det = ea * ud - ed * ua
    ok = np.isfinite(v_asc) & np.isfinite(v_desc) & np.isfinite(det) & (np.abs(det) >= min_det)
    with np.errstate(invalid="ignore", divide="ignore"):
        east = (ud * v_asc - ua * v_desc) / det
        up = (-ed * v_asc + ea * v_desc) / det
        s_east = np.sqrt(ud**2 * s_asc**2 + ua**2 * s_desc**2) / np.abs(det)
        s_up = np.sqrt(ed**2 * s_asc**2 + ea**2 * s_desc**2) / np.abs(det)
    nan = np.full_like(v_asc, np.nan)
    return {
        "east": np.where(ok, east, nan),
        "up": np.where(ok, up, nan),
        "east_sigma": np.where(ok, s_east, nan),
        "up_sigma": np.where(ok, s_up, nan),
    }


def _los_on_grid(static_file: Path, grid: xr.DataArray) -> np.ndarray:
    da = rioxarray.open_rasterio(static_file, masked=True).astype(np.float32)
    out = da.rio.reproject_match(grid, resampling=Resampling.bilinear, nodata=np.nan)
    los = np.asarray(out.values, dtype=np.float64)
    los[:, ~np.isfinite(los).all(axis=0)] = np.nan
    return los


def combine_job(job_dir: Path, area_wkt: str, frames: list[dict]) -> dict:
    """Merge and decompose the finished frames of a job. `frames` are status.json entries
    with ``cube`` and (optionally) ``static`` = {"line_of_sight_enu": path} (relative paths)."""
    done = [f for f in frames if f.get("state") == "done" and f.get("cube")]
    if not done:
        return {"error": "no finished frames"}
    first_attrs = dict(zarr.open_group(job_dir / done[0]["cube"] / "0", mode="r").attrs)
    crs = first_attrs["proj:code"]
    grid = target_grid(area_wkt, crs)
    template = grid.copy()
    out_dir = job_dir / "out" / "combined"
    out_dir.mkdir(parents=True, exist_ok=True)
    result: dict = {"crs": crs, "shape": list(grid.shape), "files": [], "merge": {}}

    def write(arr: np.ndarray, name: str, units: str, desc: str, kind: str) -> None:
        da = template.copy(data=arr.astype(np.float32))
        da = _with_geo(da, crs, da.rio.transform())
        rec = _write(da, out_dir / f"{name}.tif", units, desc)
        result["files"].append({**rec, "path": f"out/combined/{rec['path']}", "kind": kind})

    merged: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray | None]] = {}
    for direction in ("asc", "desc"):
        items = []
        los_list = []
        for f in (x for x in done if x["direction"] == direction):
            cube = job_dir / f["cube"]
            vel = _on_grid(_cube_layer(cube, "velocity"), grid)
            sig = _on_grid(_cube_layer(cube, "velocity_stderr"), grid)
            items.append({"frame": f["frame"], "velocity": vel, "sigma": sig})
            los_file = (f.get("static") or {}).get("line_of_sight_enu")
            if los_file:
                los = _los_on_grid(job_dir / los_file, grid)
                los_list.append(np.where(np.isfinite(vel)[None], los, np.nan))
        if not items:
            continue
        v, s, info = merge_direction(items)
        result["merge"][direction] = info
        los = None
        if los_list:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # pixels outside every frame
                los = np.nanmean(np.stack(los_list), axis=0)  # frames of one track share geometry
        merged[direction] = (v, s, los)
        label = "ascending" if direction == "asc" else "descending"
        write(v, f"{direction}_velocity", "m/yr", f"{label} LOS velocity, frames merged", f"{direction}_velocity")
        write(s, f"{direction}_velocity_sigma", "m/yr", f"1-sigma of the merged {label} velocity", f"{direction}_velocity_sigma")
        log.info("merged %s: %s", direction, info)

    if "asc" in merged and "desc" in merged and merged["asc"][2] is not None and merged["desc"][2] is not None:
        (va, sa, la), (vd, sd, ld) = merged["asc"], merged["desc"]
        dec = decompose(va, sa, la, vd, sd, ld)
        write(dec["up"], "vertical_velocity", "m/yr", "vertical velocity (up positive) from asc+desc", "vertical_velocity")
        write(dec["east"], "east_velocity", "m/yr", "east-west velocity (east positive) from asc+desc", "east_velocity")
        write(dec["up_sigma"], "vertical_velocity_sigma", "m/yr", "1-sigma of the vertical velocity", "vertical_velocity_sigma")
        write(dec["east_sigma"], "east_velocity_sigma", "m/yr", "1-sigma of the east velocity", "east_velocity_sigma")
        result["decomposition"] = {
            "valid_fraction": float(np.isfinite(dec["up"]).mean()),
            "vertical_median_m_yr": float(np.nanmedian(dec["up"])) if np.isfinite(dec["up"]).any() else None,
            "assumption": "north component neglected",
        }
    elif "asc" in merged and "desc" in merged:
        result["decomposition"] = {"error": "line-of-sight layers missing"}
    else:
        result["decomposition"] = {"error": "needs both ascending and descending frames"}
    return result


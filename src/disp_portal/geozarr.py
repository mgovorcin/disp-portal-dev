"""Write a DISP-S1 subset stack as a multiscale GeoZarr cube.

Input: the Zarr stack from ``opera_utils.disp.reformat_stack`` (displacement rebased to the
first reference date, CF ``spatial_ref``). Output layout (Zarr v3)::

    cube.zarr/                 root: multiscales layout, proj:, zarr_conventions, metadata
      0/                       full resolution (spatial:, proj: attrs; x, y, time coords)
        displacement           (time, y, x) float32, m, LOS, positive towards the satellite
        short_wavelength_displacement (time, y, x) float32, m
        velocity               (y, x) float32, m/yr, least-squares slope of displacement
        velocity_stderr        (y, x) float32, m/yr, formal 1-sigma (white noise)
        valid_epochs           (y, x) uint16, epochs used for the velocity
        average_temporal_coherence (y, x) float32
        water_mask             (y, x) uint8 (if present)
      1/ 2/ ...                2x mean-coarsened levels until the grid is < `min_size`

Attributes follow the GeoZarr conventions as implemented by geozarr-toolkit (``spatial:``,
``proj:``, ``multiscales``) and the cube is validated with ``validate_group`` after writing.

Note: the ``GeoTransform`` stored on ``spatial_ref`` by reformat_stack describes the whole
frame, not the subset, so the transform is derived from the x/y coordinates instead.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rioxarray  # noqa: F401  (registers .rio)
import xarray as xr
import zarr
from affine import Affine
from geozarr_toolkit import (
    MultiscalesConventionMetadata,
    ProjConventionMetadata,
    create_geozarr_attrs,
    create_multiscales_layout,
    create_zarr_conventions,
    validate_group,
)
from pyproj import CRS

YEAR_S = 365.25 * 86400.0
STACK_VARS = ("displacement", "short_wavelength_displacement")
STATIC_VARS = ("average_temporal_coherence", "water_mask")


def _years(time: np.ndarray) -> np.ndarray:
    return (time - time[0]).astype("timedelta64[s]").astype(float) / YEAR_S


def velocity_fit(da: xr.DataArray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-pixel least-squares slope (m/yr), its formal 1-sigma, and the epoch count.

    NaNs are skipped per pixel; pixels with fewer than 3 valid epochs get NaN. Dask-backed
    arrays are fitted block by block (all epochs, 512 x 512 pixels), so whole frames fit in
    a few GB of memory.
    """
    t = _years(da.time.values)
    if da.chunks is None:
        return _fit(np.asarray(da.values), t)
    arr = da.data.rechunk({0: -1, 1: 512, 2: 512})
    out = arr.map_blocks(
        lambda b: np.stack([x.astype(np.float32) for x in _fit(b, t)]),
        dtype=np.float32,
        chunks=((3,), arr.chunks[1], arr.chunks[2]),
    ).compute()
    return out[0], out[1], out[2]


def _fit(values: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    y = np.asarray(values, dtype=np.float64)  # (time, ny, nx)
    valid = np.isfinite(y)
    n = valid.sum(axis=0).astype(float)
    tt = np.where(valid, t[:, None, None], 0.0)
    yy = np.where(valid, y, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        tm = tt.sum(0) / n
        ym = yy.sum(0) / n
        dt = np.where(valid, t[:, None, None] - tm, 0.0)
        sxx = (dt * dt).sum(0)
        slope = (dt * (yy - ym)).sum(0) / sxx
        resid = np.where(valid, y - (ym + slope * (t[:, None, None] - tm)), 0.0)
        sigma2 = (resid * resid).sum(0) / (n - 2)
        stderr = np.sqrt(sigma2 / sxx)
    bad = (n < 3) | ~(sxx > 0)
    slope[bad] = np.nan
    stderr[bad] = np.nan
    return slope.astype(np.float32), stderr.astype(np.float32), n


def _crs_of(ds: xr.Dataset) -> CRS:
    ref = ds["spatial_ref"]
    wkt = ref.attrs.get("crs_wkt") or ref.attrs.get("spatial_ref")
    if not wkt:
        raise ValueError("stack has no CRS in spatial_ref")
    return CRS.from_wkt(wkt)


def _transform_from_coords(x: np.ndarray, y: np.ndarray) -> Affine:
    """Pixel-corner affine transform from pixel-centre coordinates."""
    dx = float(x[1] - x[0]) if x.size > 1 else 30.0
    dy = float(y[1] - y[0]) if y.size > 1 else -30.0
    return Affine(dx, 0.0, float(x[0]) - dx / 2, 0.0, dy, float(y[0]) - dy / 2)


def _level_dataset(src: xr.Dataset, crs: CRS) -> xr.Dataset:
    """Variables written at every level, with CRS/transform set for rioxarray and CF."""
    out = xr.Dataset(coords={"time": src.time, "y": src.y, "x": src.x})
    for name in STACK_VARS:
        if name in src:
            out[name] = src[name].astype(np.float32)
    for name in STATIC_VARS:
        if name in src:
            out[name] = src[name]
    if "reference_time" in src:
        out = out.assign_coords(reference_time=("time", src["reference_time"].values))
    out = out.rio.write_crs(crs)
    out = out.rio.write_transform(_transform_from_coords(out.x.values, out.y.values))
    return out


def coarsen_level(ds: xr.Dataset, factor: int) -> xr.Dataset:
    """Mean-coarsen by `factor` (water mask: max, epoch count: min); NaNs are skipped."""
    coarse = ds.coarsen(y=factor, x=factor, boundary="trim").mean(keep_attrs=True)
    if "water_mask" in ds:
        coarse["water_mask"] = ds["water_mask"].coarsen(y=factor, x=factor, boundary="trim").max()
    if "valid_epochs" in ds:
        coarse["valid_epochs"] = ds["valid_epochs"].coarsen(y=factor, x=factor, boundary="trim").min()
    return coarse


def build_levels(level0: xr.Dataset, min_size: int = 256, max_levels: int = 8) -> list[xr.Dataset]:
    """Level 0 plus 2x mean-coarsened levels until the smaller side drops below `min_size`."""
    levels = [level0]
    while len(levels) < max_levels and min(levels[-1].sizes["y"], levels[-1].sizes["x"]) >= 2 * min_size:
        levels.append(coarsen_level(levels[-1], 2))
    return levels


# Stacks larger than this are processed lazily with dask instead of loaded into memory.
IN_MEMORY_BYTES = 4e9


def write_geozarr(
    stack_path: str | Path,
    out_path: str | Path,
    *,
    min_size: int = 256,
    chunk: int = 256,
    time_chunk: int = 8,
    coarsen: int = 1,
    variables: tuple[str, ...] = STACK_VARS,
    fit: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    reference: np.ndarray | None = None,
    metadata: dict | None = None,
) -> dict:
    """Convert a reformat_stack Zarr to a multiscale GeoZarr cube. Returns a summary dict.

    The velocity is always fitted at the stack's full resolution. With ``coarsen > 1`` the
    cube's level 0 is the stack mean-coarsened by that factor (e.g. 3 -> 90 m). Large
    stacks (> ``IN_MEMORY_BYTES``) stay dask-backed and each level is written from the
    level before it, read back from the output store.
    """
    stack_path, out_path = Path(stack_path), Path(out_path)
    ds = xr.open_zarr(stack_path, consolidated=False)
    if "displacement" not in ds:
        raise ValueError(f"{stack_path} has no displacement variable")
    crs = _crs_of(ds)
    full = _level_dataset(ds, crs)
    if reference is not None:  # per-epoch spatial reference (m), subtracted from displacement
        attrs = full["displacement"].attrs
        ref = xr.DataArray(np.asarray(reference, dtype=np.float32), dims="time", coords={"time": full.time})
        full["displacement"] = (full["displacement"] - ref).astype(np.float32)
        full["displacement"].attrs = attrs
    full = full.drop_vars([v for v in STACK_VARS if v in full and v not in variables])
    lazy = full.nbytes > IN_MEMORY_BYTES
    full = full if lazy else full.load()

    # `fit`: a full-resolution velocity_fit result already computed by the caller (reused).
    vel, vel_std, n_valid = fit if fit is not None else velocity_fit(full["displacement"])
    level0 = full
    level0["velocity"] = (("y", "x"), vel)
    level0["velocity_stderr"] = (("y", "x"), vel_std)
    level0["velocity"].attrs = {"units": "m/yr", "long_name": "LOS velocity (least-squares slope of displacement)"}
    level0["velocity_stderr"].attrs = {"units": "m/yr", "long_name": "formal 1-sigma of velocity (white noise)"}
    level0["valid_epochs"] = (("y", "x"), n_valid.astype(np.uint16))
    level0["valid_epochs"].attrs = {"long_name": "number of epochs with valid displacement"}
    for name in STACK_VARS:
        if name in level0:
            level0[name].attrs = {k: v for k, v in ds[name].attrs.items() if k != "grid_mapping"}
            level0[name].attrs.setdefault("units", "meters")
    if coarsen > 1:
        level0 = coarsen_level(level0, coarsen)

    levels = [level0] if lazy else build_levels(level0, min_size=min_size)
    epsg = crs.to_epsg()
    crs_code = f"EPSG:{epsg}" if epsg else crs.to_wkt()
    if out_path.exists():
        import shutil

        shutil.rmtree(out_path)
    zarr.open_group(out_path, mode="w", zarr_format=3)
    layout = []
    i = 0
    while i < len(levels):
        level = levels[i]
        level = level.rio.write_crs(crs).rio.write_transform(_transform_from_coords(level.x.values, level.y.values))
        encoding = {}
        for name, da in level.data_vars.items():
            chunks = tuple(
                min(time_chunk if d == "time" else chunk, level.sizes[d]) for d in da.dims
            )
            encoding[name] = {"chunks": chunks}
        if lazy:
            level = level.chunk({d: encoding_chunk for d, encoding_chunk in zip(
                ("time", "y", "x"), (time_chunk, chunk, chunk), strict=True) if d in level.dims})
        for da in level.data_vars.values():
            da.encoding.pop("chunks", None)
            da.encoding.pop("preferred_chunks", None)
        level.to_zarr(out_path, group=str(i), mode="w", zarr_format=3, consolidated=False, encoding=encoding)
        if lazy and min(level.sizes["y"], level.sizes["x"]) >= 2 * min_size and len(levels) < 8:
            written = xr.open_zarr(out_path, group=str(i), consolidated=False)
            levels.append(coarsen_level(written.drop_vars("spatial_ref", errors="ignore"), 2))
        t = level.rio.transform()
        x0, y1 = t.c, t.f
        x1 = x0 + t.a * level.sizes["x"]
        y0 = y1 + t.e * level.sizes["y"]
        geo = create_geozarr_attrs(
            ["y", "x"],
            crs=crs_code,
            transform=[t.a, t.b, t.c, t.d, t.e, t.f],
            bbox=[min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)],
            shape=[level.sizes["y"], level.sizes["x"]],
        )
        zarr.open_group(out_path / str(i), mode="a").attrs.update(geo)
        entry: dict = {"asset": str(i)}
        if i > 0:
            entry |= {"derived_from": str(i - 1), "transform": {"scale": [2.0, 2.0]}}
        layout.append(entry)
        i += 1

    root = zarr.open_group(out_path, mode="a")
    root_attrs = {
        **create_multiscales_layout(layout, resampling_method="average"),
        "proj:code": crs_code,
        "zarr_conventions": create_zarr_conventions(MultiscalesConventionMetadata(), ProjConventionMetadata()),
        "title": "OPERA L3 DISP-S1 subset (GeoZarr)",
        "source": "OPERA_L3_DISP-S1_V1 via opera-utils run_download + reformat_stack",
        "displacement_convention": "LOS, positive towards the satellite, rebased to the first reference date",
        "time_range": [str(level0.time.values[0])[:10], str(level0.time.values[-1])[:10]],
        "resolution_m": abs(float(level0.x.values[1] - level0.x.values[0])) if level0.sizes["x"] > 1 else None,
        **(metadata or {}),
    }
    root.attrs.update(root_attrs)

    problems = {k: v for k, v in validate_group(root).items() if v}
    for i in range(len(levels)):
        level_problems = {k: v for k, v in validate_group(zarr.open_group(out_path / str(i))).items() if v}
        if level_problems:
            problems[f"level {i}"] = level_problems
    return {
        "path": str(out_path),
        "crs": crs.to_string(),
        "epsg": crs.to_epsg(),
        "levels": [dict(level.sizes) for level in levels],
        "variables": list(levels[0].data_vars),
        "n_epochs": int(level0.sizes["time"]),
        "time_range": root_attrs["time_range"],
        "velocity_median_m_yr": float(np.nanmedian(vel)) if np.isfinite(vel).any() else None,
        "valid_velocity_fraction": float(np.isfinite(vel).mean()),
        "validation": problems or "ok",
    }

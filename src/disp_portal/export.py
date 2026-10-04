"""Export a DISP-S1 GeoZarr cube (level 0) to Cloud-Optimized GeoTIFFs for GeoLibre.

Files, next to the cube, in the cube's projected CRS (float32, NaN nodata, DEFLATE, overviews)::

    <stem>_velocity.tif             m/yr
    <stem>_velocity_stderr.tif      m/yr (formal 1-sigma)
    <stem>_coherence.tif            average temporal coherence
    <stem>_displacement_<YYYYMMDD>.tif   cumulative displacement at the last epoch, m
    <stem>_epochs/displacement_<YYYYMMDD>.tif   one per epoch (optional, for a time slider)

Runs in jobs-env (rioxarray + GDAL COG driver).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rioxarray  # noqa: F401  (registers .rio)
import xarray as xr
from affine import Affine

COG_CREATION_OPTIONS = ["COMPRESS=DEFLATE", "PREDICTOR=FLOATING_POINT", "OVERVIEW_RESAMPLING=AVERAGE", "BLOCKSIZE=256"]


def _with_geo(da: xr.DataArray, crs: str, transform: Affine) -> xr.DataArray:
    da = da.drop_vars([c for c in da.coords if c not in ("x", "y")], errors="ignore")
    da = da.astype(np.float32).rio.write_crs(crs).rio.write_transform(transform)
    return da.rio.write_nodata(np.nan, encoded=False)


def _write(da: xr.DataArray, path: Path, units: str, description: str) -> dict:
    """Write a plain GeoTIFF, then GDAL-translate it to COG.

    Writing with ``rio.to_raster(driver="COG")`` produced all-zero files with rasterio 1.5 in
    jobs-env (the COG driver is copy-only and rasterio's emulation lost the data), so the COG
    is made by GDAL's own CreateCopy from a regular GTiff.
    """
    from osgeo import gdal

    da.attrs = {"units": units, "long_name": description}
    tmp = path.with_suffix(".tmp.tif")
    with np.errstate(invalid="ignore"):  # NaN nodata cast inside rasterio warns harmlessly
        da.rio.to_raster(tmp)
    gdal.UseExceptions()
    gdal.Translate(str(path), str(tmp), format="COG", creationOptions=COG_CREATION_OPTIONS)
    tmp.unlink()
    return {"path": path.name, "units": units, "description": description}


def export_geotiffs(cube: str | Path, *, epochs: bool = False) -> list[dict]:
    """Write COGs for a GeoZarr cube written by :func:`disp_portal.geozarr.write_geozarr`.

    Returns one record per file: path (relative to the cube's folder), kind, units, date.
    """
    cube = Path(cube)
    ds = xr.open_zarr(cube, group="0", consolidated=False)
    import zarr

    attrs = dict(zarr.open_group(cube / "0", mode="r").attrs)
    crs = attrs["proj:code"]
    transform = Affine(*attrs["spatial:transform"][:6])
    stem = cube.name.removesuffix(".zarr")
    out_dir = cube.parent
    records: list[dict] = []

    for var, suffix, units, desc in (
        ("velocity", "velocity", "m/yr", "LOS velocity, positive towards the satellite"),
        ("velocity_stderr", "velocity_stderr", "m/yr", "formal 1-sigma of the velocity"),
        ("average_temporal_coherence", "coherence", "1", "average temporal coherence"),
    ):
        if var in ds:
            path = out_dir / f"{stem}_{suffix}.tif"
            rec = _write(_with_geo(ds[var].load(), crs, transform), path, units, desc)
            records.append({**rec, "kind": suffix})

    disp = ds["displacement"]
    last = str(np.datetime_as_string(disp.time.values[-1], unit="D")).replace("-", "")
    first = str(np.datetime_as_string(disp.time.values[0], unit="D"))
    path = out_dir / f"{stem}_displacement_{last}.tif"
    rec = _write(
        _with_geo(disp.isel(time=-1).load(), crs, transform),
        path,
        "m",
        f"cumulative LOS displacement since {first}, positive towards the satellite",
    )
    records.append({**rec, "kind": "displacement_last", "date": f"{last[:4]}-{last[4:6]}-{last[6:]}"})

    if epochs:
        epoch_dir = out_dir / f"{stem}_epochs"
        epoch_dir.mkdir(exist_ok=True)
        for i, t in enumerate(disp.time.values):
            day = str(np.datetime_as_string(t, unit="D"))
            path = epoch_dir / f"displacement_{day.replace('-', '')}.tif"
            _write(_with_geo(disp.isel(time=i).load(), crs, transform), path, "m", f"cumulative LOS displacement at {day}")
            records.append({"path": f"{epoch_dir.name}/{path.name}", "kind": "displacement_epoch", "date": day, "units": "m"})
    return records

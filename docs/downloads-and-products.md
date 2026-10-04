# Downloads and products

Server-side processing behind `disp-proxy` (needs the `jobs-env` conda environment).

#### Download jobs

Jobs run `jobs-env/bin/python -m disp_portal.prepare jobs/<id>/job.json` (needs GDAL and the local
opera-utils, so a separate conda env; Earthdata login from `~/.netrc`). The DISP-S1-STATIC download
(`opera_utils.disp._static`) and `reformat_stack(reference_method=NONE)` used here are in a fork of
opera-utils and not yet upstream. Create the env once:

```bash
mamba create -p jobs-env -c conda-forge "python=3.12" gdal rasterio rioxarray xarray h5netcdf h5py "zarr>=3" dask pyproj shapely geopandas pyogrio pip
jobs-env/bin/pip install -e "path/to/opera-utils[disp]" geozarr-toolkit mercantile httpx pillow
jobs-env/bin/pip install --no-deps -e .
```

API: `POST /jobs {"bbox"|"geometry", "start", "end", "directions", "apply_solid_earth", "apply_ionosphere", "geotiff", "geotiff_epochs", "combine"}`,
`GET /jobs`, `GET /jobs/{id}?log=40`, `POST /jobs/{id}/cancel`, `DELETE /jobs/{id}`,
`GET /jobs/{id}/files/<path>`, `GET /jobs-usage`. Limits via env: `DISP_JOBS_MAX_AREA_KM2` (2500),
`DISP_JOBS_MAX_CONCURRENT` (2), `DISP_JOBS_MAX_AGE_DAYS` (30), `DISP_JOBS_MAX_TOTAL_GB` (20).
GeoZarr/COG tests need GDAL: `jobs-env/bin/python -m pytest tests/test_geozarr_export.py tests/test_combine.py`.

With `combine` (default on) each frame's DISP-S1-STATIC line of sight is downloaded for the job
area (`opera_utils.disp._static`), frames are merged per direction (median overlap offset, 1/σ²
weights) and, with both directions, vertical and east velocity are solved (north neglected).
Results: `out/combined/*.tif` and `combined` in the job status; the plugin shows them in the
"Combined" block of the Downloads window. Check: `scripts/check_combined.py --job <id>`.

#### Whole-frame velocity products

`disp_portal.products` (jobs-env) processes whole DISP-S1 frames one by one through a scratch
folder: streaming download, re-referencing, 30 m velocity fit, COGs, a 90 m GeoZarr cube
(30 m with `--full-res-cube`) and the static line of sight; raw data are deleted after each frame.

```bash
jobs-env/bin/python -m disp_portal.products catalog --region conus      # frames + CMR counts
jobs-env/bin/python -m disp_portal.products run --region houston --parallel 1 --full-res-cube
jobs-env/bin/python -m disp_portal.products run --region conus --parallel 2   # resumable
jobs-env/bin/python -m disp_portal.products status
```

Outputs in `products/frames/Fxxxxx/` (override with `DISP_PRODUCTS_DIR` for the proxy). The proxy
serves them at `/products` and `/products/files/...`; their cubes are used by `/cubes/timeseries`
and `/cubes/analyze`; the plugin's "Products" button opens the list. Dask threads per frame:
`DISP_PRODUCTS_DASK_THREADS` (8).

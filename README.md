# OPERA DISP Portal (disp-portal-dev)

> **🚧 In development.** This is a community prototype, **not an official OPERA, JPL or NASA product**.
> Interfaces, data paths and results change without notice; do not use them for decisions.
> Software release under JPL review; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

**Live static demo:** <https://mgovorcin.github.io/disp-portal-dev/>

A viewer for [OPERA](https://www.jpl.nasa.gov/go/opera/) L3 surface displacement (DISP-S1) built as a
plugin for [GeoLibre](https://github.com/opengeos/GeoLibre). It is similar to the
[ASF Displacement Portal](https://displacement.asf.alaska.edu/), and adds analysis with your own data,
interactive time-series fitting, subset downloads (GeoZarr / COG), and frame merging with
vertical/east decomposition.

| | Static demo (GitHub Pages) | Local, with `disp-proxy` |
|---|---|---|
| Time series from ASF, model fits, PNG/CSV export | ✅ | ✅ |
| OPERA frames in view, search, draw / annotate, roads · geology · 3D buildings demo | ✅ | ✅ |
| ASF velocity overview (asc/desc) | ✅ mirrored up to zoom 10 (~150 m, WebP), refreshed monthly | ✅ full resolution (zoom 12, ~38 m) |
| Identify velocity on click, layer analysis | – | ✅ |
| Subset downloads → GeoZarr / COG, merge + vertical/east (beta), whole-frame products | – | ✅ |

The static site can also use a proxy running on your machine: start `disp-proxy` (below) and enter
`http://localhost:8790` under **OPERA DISP → Settings**.

The rest of this file is the developer guide.

## About

An OPERA DISP viewer on [GeoLibre](https://github.com/opengeos/GeoLibre), similar to the
[ASF Displacement Portal](https://displacement.asf.alaska.edu/#/?dispOverview=VEL), with analysis
against user data and time-series retrieval. See [PLAN.md](PLAN.md) for goals and tasks, and
[PHASE0_NOTES.md](PHASE0_NOTES.md) for what was measured.

## Layout

```
src/disp_portal/asf.py      ASF client: /frame_intersection, /timeseries, tile + extent URLs
src/disp_portal/tiles.py    overview tile decoder (byte -> m/yr), ASF colour ramp, mosaics, disk cache
src/disp_portal/proxy.py    disp-proxy (FastAPI): ASF tiles with CORS, values, profiles, zonal stats
src/disp_portal/viewer.html test viewer served by the proxy at /
src/disp_portal/basemaps.py no-key basemap catalogue (Light, Dark, OSM, Google satellite/hybrid)
scripts/check_viewer.py     headless Chromium check of the viewer and cross-origin tile loading
scripts/check_geolibre.py   end-to-end check of the plugin inside GeoLibre web
plugin/                     GeoLibre plugin "opera-disp" (TypeScript, Vite); bundle in plugin/geolibre-plugin/
scripts/validate_decoder.py decoded tiles vs ASF time-series slopes, timings, edge cases
scripts/build_phase0_notebook.py  generates notebooks/00_asf_prototype.ipynb
notebooks/                  Phase 0 prototype (kernel "disp-portal (Portal/.venv)")
tests/                      offline unit tests
results/phase0/             validation CSV and figures
```

## Setup

```bash
uv sync --all-extras
.venv/bin/python -m pytest -q
.venv/bin/python scripts/validate_decoder.py       # network, about 1 min
```

## disp-proxy (Phase 1a)

```bash
.venv/bin/disp-proxy --port 8790          # binds 127.0.0.1; logs to stdout
```

From a laptop through VS Code Remote: forward port 8790 (Ports panel), then open
<http://localhost:8790/> for the test viewer (click the map for value + time series).

| Endpoint | Purpose |
|---|---|
| `GET /tiles/{asc,desc}/{vel,disp}/{z}/{x}/{y}.png` | colourised tiles (ASF ramp), CORS `*`; use as an XYZ layer |
| `GET /raw/{dir}/{kind}/{z}/{x}/{y}.png` | original encoded tiles |
| `GET /value?lon=&lat=&dir=asc` | decoded value at zoom 12 |
| `POST /sample` `{"points": [[lon, lat], ...], "direction": "asc"}` | values at many points |
| `POST /profile` `{"line": <GeoJSON LineString>, "step_m": 30}` | values along a line |
| `POST /stats` `{"geometry": <GeoJSON Polygon>, "threshold": -0.005}` | zonal statistics |
| `POST /analyze` `{"features": [...], "direction": "asc", "abs_threshold": 0.005, "step_m": 30}` | statistics for many points/lines/polygons |
| `GET /extent/{dir}/{kind}` | scale range, tile date, legend colours |
| `GET /basemaps`, `GET /basemaps/{key}.json` | basemap catalogue and MapLibre style per basemap |
| `GET /project.json?lon=&lat=&z=&basemap=&dir=&demo=` | GeoLibre project that loads the plugin from this proxy (`demo=1` adds a Houston sample layer) |
| `GET /plugin/{plugin.json,dist/index.js,dist/style.css}` | the built plugin bundle |

Only velocity (`vel`) exists on the ASF side; the cumulative displacement overview (`disp`) returns 404.

In GeoLibre (web or desktop): **Add Data → XYZ tiles** with
`http://localhost:8790/tiles/asc/vel/{z}/{x}/{y}.png`. Settings via env vars:
`DISP_PROXY_ORIGINS` (default `*`), `DISP_PROXY_CACHE`, `DISP_PROXY_CONCURRENCY`, `DISP_PROXY_MAX_STATS_TILES`.

Browser check (needs Playwright's headless Chromium):

```bash
.venv/bin/python scripts/check_viewer.py   # set PLAYWRIGHT_BROWSERS_PATH if browsers live elsewhere
```

## GeoLibre with OPERA DISP (self-hosted)

The proxy serves its own GeoLibre web build with the OPERA DISP plugin baked in and active by
default: open <http://localhost:8790/> (port 8790 forwarded). Same origin, so no "Trust and load"
and no local-network prompt, and the plugin is there after every reload. Options:
`/?demo=1`, `/?basemap=dark&dir=desc&lon=-119.5&lat=36.1&z=9`. The old test page is `/viewer`.

Build (once, and after plugin or GeoLibre updates; ~10 min), then restart the proxy:

```bash
git clone https://github.com/opengeos/GeoLibre.git vendor/GeoLibre   # pinned in geolibre-web/BUILD_INFO.txt
(cd vendor/GeoLibre && npm ci --ignore-scripts)
scripts/build_geolibre.sh          # -> geolibre-web/ (202 MB); Notebook panel (JupyterLite) not included
```

The proxy also serves `/deployment.json` (OPERA DISP default-active, app name, no welcome) and a
`/sw.js` that removes GeoLibre's offline service worker, so options like `?demo=1` reach the proxy.
Without `geolibre-web/`, `/` redirects to GeoLibre web (`https://web.geolibre.app/?url=…`) as before.

### Download jobs (Phase 1e)

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

### Whole-frame velocity products (Phase 2)

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

### Keep the proxy running

Processes started from an editor or terminal session stop with it. `scripts/ensure_proxy.sh` starts the
proxy detached if `/health` does not answer; run it from cron to keep it up (your choice):

```bash
(crontab -l; echo "* * * * * /path/to/disp-portal-dev/scripts/ensure_proxy.sh") | crontab -
```

## GeoLibre plugin (Phase 1b)

With GeoLibre web instead of the self-hosted build: <https://web.geolibre.app/?url=http://localhost:8790/project.json>.

1. Chrome asks to let web.geolibre.app access devices on your local network: **Allow**
   (Local Network Access; needed because the proxy is on localhost).
2. GeoLibre asks "Load plugins from this project?": **Trust and load**.

The **OPERA DISP** panel opens on the right:
- velocity overview on/off, ascending/descending, opacity, and a legend with the tile date
- basemap: GeoLibre default, Light, Dark, OpenStreetMap, Satellite (Google), Satellite hybrid (Google); labels drawn above the velocity for Light/Dark
- frame outlines and the list of frames in view (from zoom 5)
- click to identify the asc and desc velocity
- search box (place names via OpenStreetMap, or "lat, lon"), map tools: Draw polygon (GeoEditor),
  Annotations
- time-series mode: map button with a chart icon (top right), off by default; when on, each map click
  adds a pick (or use drawn shapes / selected features); the
  floating "OPERA DISP time series" window charts asc (dots) and desc (rings):
  - interactive: drag to zoom time, mouse wheel to zoom at the cursor, double-click / Reset zoom,
    click legend entries to hide series, hover for values
  - model fit: polynomial order 0–3, annual, semi-annual, steps (type a date or "Pick step on
    chart"), optional 3σ outlier rejection; rate (mid-epoch) ± 1σ, amplitudes ± 1σ with peak day,
    step sizes ± 1σ, RMS, outliers drawn as grey rings
  - view data or residuals (data − model); relative to any pick
  - source: ASF service and/or your downloaded cubes (full or short-wavelength displacement,
    drawn as lines; read via `POST /cubes/timeseries`)
  - Export CSV (data + model + residual + outlier flag) and Export fit (parameters ± 1σ)
- analyze layer: pick drawn shapes, the selection, or any vector layer; you get a new layer with
  velocity attributes coloured by `vel_mmyr` (7 classes, legend in the results window), a red
  "hotspots ≥ N mm/yr" layer when any feature reaches the threshold (|median| in a direction with
  enough valid pixels), and a results table with zoom-to-feature, CSV and time series for the top
  features. When nothing reaches the threshold the message gives the largest value found.
  "Velocity from: downloaded cubes" uses your downloads instead of the ASF tiles: float velocity of
  the full displacement with σ; a cube hotspot must also be ≥ 2σ (`POST /cubes/analyze`).
- time-series points (and chart settings) are kept across reloads in this browser and saved in
  GeoLibre project files (Project → Save).
  Try it with <http://localhost:8790/?demo=1>
- download subset (DISP-S1): area from a drawn shape, the selection or the map view (≤ 2,500 km²),
  dates, directions, corrections → the server downloads only that area with opera-utils,
  re-references it and writes a multiscale GeoZarr cube per frame/direction under `jobs/<id>/out/`,
  plus (optional) Cloud-Optimized GeoTIFFs: velocity, σ, coherence, last displacement, every epoch.
  The "OPERA DISP downloads" window shows progress and disk use; "Show velocity" loads the cube,
  the COG buttons add the GeoTIFFs as GeoLibre layers, ↓ downloads a file.
- proxy URL

Both layers appear in GeoLibre's Layers panel, where opacity and visibility work. URL parameters
as in the ASF portal: add `&dispOverview=VEL&dir=desc` to the GeoLibre URL.

Build and test:

```bash
cd plugin
npm install
npm test            # vitest, 65 tests
npm run build       # -> geolibre-plugin/dist (served by the proxy at /plugin/)
npm run package     # -> geolibre-plugin/opera-disp-0.1.0.zip (Plugins > Install from file, or desktop plugins dir)
cd ..
.venv/bin/python scripts/check_geolibre.py    # layers, identify, time series, basemaps
.venv/bin/python scripts/check_analysis.py    # analyze layer on the demo data
.venv/bin/python scripts/check_timeseries_fit.py  # model fitting, steps, zoom, residuals, exports
.venv/bin/python scripts/check_selfhosted.py      # self-hosted GeoLibre: no prompts, survives reloads
.venv/bin/python scripts/check_downloads.py       # loading banner, points layer, download → GeoZarr → map
.venv/bin/python scripts/check_ux.py              # time-series mode button, cube series, search, tools
.venv/bin/python scripts/check_phase2b.py         # analysis from cubes, points survive reload
```

### If the plugin is missing in GeoLibre

1. Check the proxy: `curl localhost:8790/health`. If it does not answer, run
   `scripts/ensure_proxy.sh` (and re-forward port 8790 in VS Code if needed).
2. Open <http://localhost:8790/> (self-hosted build: always loaded). On GeoLibre web, reopen the
   `?url=…/project.json` link and accept "Trust and load".
3. Panel closed but plugin loaded: toolbar menu **OPERA DISP → Open panel**.
4. Alternative: GeoLibre **Settings → Plugins → add manifest URL**
   `http://localhost:8790/plugin/plugin.json`, or **Install from file** with
   `plugin/geolibre-plugin/opera-disp-0.1.0.zip`.

Basemap terms: the Esri and Google tile endpoints are fine for a local prototype, but their terms
restrict direct tile use in public apps (GeoLibre leaves them out of its own catalogue). Review
before deploying publicly.

## Quick use

```python
from disp_portal import AsfClient, mosaic, value_at

df = AsfClient().timeseries((-95.37, 29.76), "ascending")   # tidy DataFrame, one row per epoch
v = value_at(-95.37, 29.76, "ascending")                      # decoded overview velocity, m/yr
da = mosaic((-96.0, 29.4, -94.9, 30.3), "ascending", z=11)    # EPSG:3857 xarray grid
```

Tiles are cached under `.cache/tiles/` when a `TileFetcher(cache_dir=...)` is used.

## GitHub Pages build

`scripts/build_pages.sh [/disp-portal-dev/] [dist-pages]` builds GeoLibre (pinned in
[GEOLIBRE_COMMIT](GEOLIBRE_COMMIT)) with the plugin and branding under the site's URL path, then
writes the static site files (`scripts/write_pages_static.py`): plugin site config
(`disp-portal.json`), public-use basemaps (OpenFreeMap, OpenStreetMap, EOX Sentinel-2 cloudless),
the demo project, `deployment.json` and a service-worker kill switch. `scripts/mirror_overview_tiles.py`
mirrors the ASF velocity overview (z2–10 as WebP, ~0.55 GB) into the site, because ASF's tile server only
allows its own portal to read the tiles from a browser. The
[Pages workflow](.github/workflows/pages.yml) runs it on every push to `main`.

## Credits

- [GeoLibre](https://github.com/opengeos/GeoLibre) (MIT, © Qiusheng Wu): the web GIS this plugin runs in.
- OPERA DISP-S1 products and time-series service: [ASF DAAC](https://asf.alaska.edu/) /
  [NASA Earthdata](https://www.earthdata.nasa.gov/); [opera-utils](https://github.com/opera-adt/opera-utils).
- Demo layers: [Overture Maps](https://overturemaps.org/) (roads, buildings; ODbL / CDLA),
  USGS [State Geologic Map Compilation](https://mrdata.usgs.gov/geology/state/) (WMS).
- Basemaps: [OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors,
  Sentinel-2 cloudless by [EOX](https://s2maps.eu/).
- The OPERA logo belongs to the OPERA project (JPL); used here only to identify the data source.

<!-- Internal development notes. -->
# OPERA DISP Portal on GeoLibre: Plan

A displacement viewer similar to the [ASF Displacement Portal](https://displacement.asf.alaska.edu/#/?dispOverview=VEL),
built as a plugin for [GeoLibre](https://github.com/opengeos/GeoLibre), with two additions:

1. Analysis of displacement together with the user's own data (shapefiles, rasters, web services).
2. Time-series retrieval for points, drawn shapes and user features.

Status: Phase 0 and Phase 1 (1a proxy on `127.0.0.1:8790`, 1b plugin, 1c time series, 1d analysis) done (2026-10-03). Next: Phase 2, our own velocity products and time-series service. Phase 1 reuses ASF assets, Phase 2 builds our own service.

---

## 1. Background: how the ASF portal works

### Velocity overview

- Pre-rendered PNG tiles:
  `https://d3g9emy65n853h.cloudfront.net/main/{asc|desc}/{vel|disp}/{z}/{x}/{y}.png`
  (256 px, EPSG:3857, max zoom 12) plus `extent.json` (`scale_range` -0.03 to 0.03 m/yr).
- The tiles are single-band 8-bit encoded values. The colormap is applied in the browser by OpenLayers WebGL.
- They are produced by [ASFHyP3/OPERA-DISP-TMS](https://github.com/ASFHyP3/OPERA-DISP-TMS)
  (`scripts/weekly-tileset-generation.py` runs HyP3 `OPERA_DISP_TMS` jobs, then syncs to
  `s3://asf-services-web-content-prod/`). `extent.json` was last modified on 2025-11-11.
- Velocity per frame:
  - input: `short_wavelength_displacement` masked with `recommended_mask == 1`, using the minimum "spanning" set of granules
  - pixels valid in at least 90 % of epochs: gaps filled with 0
  - ministacks re-referenced by simple chaining, then a per-pixel least-squares slope
  - clipped to ±3 cm/yr
  - mosaic: near-range frame on top, no seam adjustment
- **CORS:** tiles allow only `https://displacement.asf.alaska.edu`, so they **cannot** be loaded
  by MapLibre WebGL from any other origin.

### Time-series API

Base URL `https://d2qmcvu7qty7vn.cloudfront.net` (CORS `*`, callable directly from a browser).

| Endpoint | Body | Response |
|---|---|---|
| `POST /frame_intersection` | `{"wkt": "...", "flightDirection": "ascending"}` | `{"08882": "POINT (-95.4 29.75)"}` |
| `POST /timeseries` | `{"wkt": "...", "bucket": "asf-cumulus-prod-opera-products", "polarization": "VV", "flightDirection": "ASCENDING"}` | dict keyed by granule `.nc` name |

- Each entry has `netcdf_uri`, `reference_datetime`, `secondary_datetime`, `temporal_baseline`,
  `short_wavelength_displacement`, and for points also `x`, `y` (UTM).
- Ministacks appear to be re-referenced on the server: all `reference_datetime` values equal the first reference.
- Besides the granules the response has a `mean` summary entry (no dates); the ASF frontend skips it.
- Where frames overlap, the service picks one frame with no consistent rule.
- "No valid data" comes back as HTTP 500; points with no frame give HTTP 400.
- A polygon WKT returns one value per epoch (apparently the mean over the polygon) and no x/y. A ~200 m box took about 14 s.
- Only `short_wavelength_displacement`: no corrections, no uncertainty.
- The backend source is not public.

### Related pipeline

[opera-adt/opera-utils-batch](https://github.com/opera-adt/opera-utils-batch) produces richer velocity products:
- input: full `displacement`, optionally minus ionosphere and solid earth tide
- mask: average temporal coherence above 0.75
- reference: median of high-coherence pixels
- fit: polynomial plus optional seasonal terms
- outputs: `velocity`, `stderr`, `n_obs`, `average_temporal_coherence`
- mosaic: per-track offset adjustment, optional plate-motion removal
- it also builds kerchunk virtual references (`s3://opera-adt/disp/virtual-references`)

---

## 2. Goals

| # | Goal | Phase | Done when |
|---|---|---|---|
| G1 | Show ascending and descending velocity overviews, like the ASF portal | 1 | ASF velocity tiles show in GeoLibre (web and desktop) with the ASF colour ramp, an asc/desc toggle and a legend |
| G2 | Retrieve time series | 1 | point, drawn shape or selected feature gives a chart and CSV; multiple series; asc and desc; reference-point subtraction |
| G3 | Analyse displacement with user data | 1 (basic), 3 (full) | for a user-added shapefile or raster: zonal stats as attributes, sampling, raster scatter, hotspot intersection |
| G4 | Our own velocity and time-series service | 2 | own float32 velocity / stderr / n_obs COGs and own TS API (full or corrected displacement, per-pixel polygons) replace the ASF backends |
| G5 | Easy to distribute | 4 | the plugin installs from a zip or `plugin.json` URL with no GeoLibre fork |

### Out of scope at first

- Recomputing velocities in the browser.
- Calibrating with GNSS in the portal (that is cal-disp's job; the portal only displays its output).

---

## 3. What Phase 1 can reuse from ASF

| Asset | Source | Browser access | How Phase 1 uses it |
|---|---|---|---|
| Velocity tiles, asc and desc | `d3g9emy65n853h.cloudfront.net/main/{asc,desc}/vel/{z}/{x}/{y}.png` (z 2–12) | CORS-locked to the ASF portal | through our proxy |
| Cumulative displacement tiles | same host, `/{asc,desc}/disp/...` | — | **not published** (404 for tiles and `extent.json`) |
| Scale range | `.../extent.json` | CORS-locked | proxy reads it at start-up |
| Time series | `POST /timeseries` | CORS `*` | called directly from the plugin |
| Frame footprints | `POST /frame_intersection` (frame polygons clipped to the query area) | CORS `*` | frame outline layer and "which frames cover this" |
| Colour ramp | ASF frontend: 10 stops from `[0,18,97]` to `[89,0,8]` at byte 1…256 (RdBu-like) | n/a | copied into the proxy and legend |

### Tile encoding

From `OPERA-DISP-TMS/create_tile_map.py`: `gdal.Translate(scaleParams=[[-0.03, 0.03, 1, 255]], outputType=Byte)`, then `gdal2tiles --xyz --zoom=2-12`. So:

```
velocity [m/yr] = -0.03 + (byte - 1) * 0.06 / 254     (byte 0 or alpha 0 = nodata)
```

- Step 0.24 mm/yr.
- Clipped at ±3 cm/yr, so values at the ends of the ramp mean "at least 3 cm/yr".
- Finest resolution is zoom 12: about 38 m at the equator, about 33 m at 30° latitude.
- Good enough for display, identify and zonal statistics. Not good enough for uncertainty-weighted analysis (that comes in Phase 2).

---

## 4. Architecture

### Phase 1 (ASF-backed)

```
GeoLibre (web / desktop / Jupyter)
 ├─ built-in: Add Data (shp, gpkg, parquet, COG, WMS/WFS/ArcGIS), Whitebox, swipe
 └─ plugin "opera-disp"
     ├─ layers       addTileLayer → proxy /tiles/{dir}/vel/{z}/{x}/{y}.png (colour)
     ├─ identify     proxy /value?lon&lat&dir  (or decode /raw tiles in the browser)
     ├─ timeseries   ASF /frame_intersection + /timeseries (direct, CORS *)
     └─ analysis     zonal stats / sampling via proxy /stats (decoded z12 tiles)

disp-proxy (FastAPI, ours)
     GET /tiles/{dir}/{kind}/{z}/{x}/{y}.png   ASF tile → ASF colour ramp → RGBA, CORS
     GET /raw/{dir}/{kind}/{z}/{x}/{y}.png     ASF tile pass-through, CORS
     GET /value?lon=&lat=&dir=&kind=           decoded value at z12
     POST /stats {geometry, dir, kind}         decoded z12 pixels in polygon → mean/median/p95/…
     GET /extent/{dir}/{kind}                  ASF extent.json
     tile cache on disk; small LRU in memory
```

### Phase 2 (own data)

The same plugin, with the backends swapped behind one `services` interface:
- the proxy's tile and stats endpoints are replaced by `addCogLayer` on our own float32 COGs (velocity, stderr, n_obs)
- the ASF `/timeseries` call is replaced by our own TS API

GeoLibre APIs used:
- `addTileLayer`, `addCogLayer` (Phase 2), `readRasterWindow`
- `getLayerFeatures`, `getDrawnFeatures`, `getSelectedFeatures`, `addGeoJsonLayer`
- `registerRightPanel`, toolbar menus, URL parameter handlers

The right panel receives a plain DOM element (no React), so the chart library is bundled in the plugin (uPlot).

---

## 5. Tasks

### Phase 0: Prototype with ASF assets (1–2 days)

- [x] Python env (`uv`, `.venv`, Jupyter kernel `disp-portal`).
- [x] `asf.py`: Python client for `/frame_intersection`, `/timeseries` and the tile URL. Returns a tidy DataFrame; skips the `mean` entry; no-data errors are not retried.
- [x] Tile decoder: byte → m/yr. Validated against ASF time-series slopes: median |diff| 0.51 mm/yr, max 1.55 mm/yr over 13 point/direction pairs.
- [x] Notebook `notebooks/00_asf_prototype.ipynb`: decoded tiles as GeoLibre rasters (no proxy needed in Python), click for time series, polygon vs zonal stats.
- [x] Response times and edge cases recorded in `PHASE0_NOTES.md`.

### Phase 1: ASF-backed portal (about 2 weeks)

**1a. `disp-proxy` service**
- [x] `/tiles`: fetch the ASF tile, apply the ASF colour ramp, return RGBA PNG with CORS. Missing tiles return a transparent PNG; z > 12 is cut from the z12 parent.
- [x] `/raw`: pass-through with CORS, for decoding in the browser.
- [x] `/value`: decode the z12 pixel at a lon/lat (also `/sample` for batches of points and `/profile` along lines).
- [x] `/stats`: decode the z12 tiles that cover the polygon (max 256 tiles), and return n, mean, median, std, p5, p95, % clipped and % below a threshold.
- [x] `/extent`: ASF `extent.json` plus tile date, quantization and legend colours.
- [x] Disk tile cache (shared with the Python decoder) and 8 concurrent upstream requests. TTL not done yet: ASF sends no `Cache-Control`, and the tiles have not changed since 2025-11-11.
- [x] Chrome Private Network Access preflight, so https sites (GeoLibre web) can call the localhost proxy.
- [x] Test viewer at `/` (MapLibre + uPlot), checked in headless Chromium, including a cross-origin page (`scripts/check_viewer.py`).
- [x] Runs locally: `disp-proxy --port 8790`. Later, a container or Lambda behind CloudFront.

**1b. Plugin scaffold and layers** (done 2026-10-03)
- [x] Plugin in `plugin/` (TypeScript + Vite, build/packaging based on `opengeos/geolibre-plugin-template`); 20 vitest tests.
- [x] `state.ts`: proxy URL and ASF API URL, saved in the GeoLibre project; proxy URL editable in the panel.
- [x] Velocity layer (plugin-owned MapLibre layer mirrored into the Layers panel with opacity/visibility bridged), asc/desc toggle. ~~Cumulative displacement~~: ASF has no `disp` overview (404). Preset swipe: not done (moved to 1d).
- [x] Legend with the ASF ramp, in mm/yr, showing the tile date.
- [x] Frame outlines for the current view from `/frame_intersection` (debounced, from zoom 5) and frame list in the panel.
- [x] Identify: click shows the asc and desc velocity (frame ID comes with the time series in 1c).
- [x] URL parameters `dispOverview`, `dir`, `dispProxy`. Map position comes from the project (`/project.json?lon=&lat=&z=`).
- [x] Basemaps with no API key (Light, Dark, OpenStreetMap, Google satellite and hybrid) served as styles by the proxy; labels above the velocity for Light/Dark.
- [x] Proxy serves the plugin bundle and a preset project: `https://web.geolibre.app/?url=http://localhost:8790/project.json`.
- [x] End-to-end check in GeoLibre web, headless Chromium (`scripts/check_geolibre.py`).

GeoLibre host behaviour found while testing (worked around in the plugin):
- Plugins cannot remove or retarget `addTileLayer` layers, so the plugin owns its MapLibre layers and registers them with `registerExternalNativeLayer`.
- On project load GeoLibre collapses plugin panels unless the plugin sets `restoresPanelCollapseState` (it now saves `panelOpen`).
- During project load and basemap switches GeoLibre drops plugin layers; the plugin restores them within a time window and treats later removals as the user's.
- After a basemap switch GeoLibre re-applies the project's plugin settings from load time; identical payloads are ignored.
- Chrome's Local Network Access asks the user before https://web.geolibre.app may call the localhost proxy.

**1c. Time-series panel (ASF API)** (done 2026-10-03)
- [x] `timeseries.ts`: typed client with 3 retries (none for no-data errors), AbortSignal, and a cache keyed by WKT and direction; skips the `mean` entry.
- [x] Sidebar "Time series (ASF)": map click adds a pick (toggle), "Add drawn shapes", "Add selected", "Open chart", pick list with status and remove. Up to 8 picks; polygons give the service's polygon mean.
- [x] Floating chart window (uPlot, 640 px): all picks, asc filled dots / desc rings in the pick colour, optional linear fit with velocity in mm/yr.
- [x] Reference subtraction: "Relative to" any pick, on common dates per direction.
- [x] CSV export of what is shown: series, direction, frame, geometry, date, reference date, displacement (m), relative-to, source granule.
- [x] Loading and error states per pick and direction: "loading… (10–30 s)", "No valid data at this location", "No OPERA frame covers this location"; picks can be removed (cancels the request).
- [x] Frame chosen by the service and its date range shown; warning when other frames also cover the pick.
- [x] Map shows picks in their colours (points, polygon outlines).
- [x] Tests: 32 vitest; end-to-end in GeoLibre web (`scripts/check_geolibre.py`: two picks, reference, CSV download).
- [x] Interactive chart and model fitting (added 2026-10-03 on request): drag/wheel zoom, reset, legend toggles; least-squares model with polynomial order 0–3, annual, semi-annual, steps (typed or clicked on the chart), 3σ MAD outlier rejection, formal 1σ errors; residual view; fit-parameter CSV. Settings saved with the project (`fit`, `tsView`). `scripts/check_timeseries_fit.py`.
- [ ] Not yet: saving picks with the project; polygon picks tested only in unit tests (drawing in headless GeoLibre not automated); formal errors assume white noise (InSAR residuals are temporally correlated, so they are optimistic).

**1d. Basic analysis with user data** (done 2026-10-03)
- [x] Sidebar "Analyze layer": any GeoLibre layer with readable features (GeoJSON, shapefile, GeoPackage, GeoParquet, WFS, ArcGIS feature layers, drawings) or the current selection; directions, hotspot threshold, minimum valid pixels, line sampling step.
- [x] Proxy `POST /analyze`: one request per direction for many features (chunks of 500): points = pixel value, lines = samples every N m, polygons = all zoom-12 pixels inside; tiles decoded once per request.
- [x] Result written back as a new layer "<layer> · OPERA velocity" (`addGeoJsonLayer`) with original attributes plus `asc_/desc_` median, mean, p5, p95, % exceeding, % valid (mm/yr), `hotspot`, `low_coverage`, `vel_source`; styleable and filterable in GeoLibre.
- [x] Floating "OPERA DISP analysis" table: sortable, hotspots highlighted, low-coverage rows greyed, click a row to zoom, CSV export.
- [x] Hotspot rule: |median| ≥ threshold in a direction with ≥ min valid pixels (default 25 %); found necessary because a water polygon with 8 % valid pixels otherwise ranked first.
- [x] "Time series for top 8 hotspots" sends hotspot features to the 1c chart (polygons as polygon means, lines at their midpoint).
- [x] Product caveat shown in the panel and stored per feature (`vel_source`).
- [x] Demo data: `/?demo=1` opens GeoLibre with a Houston layer (areas, wells, a transect).
- [x] Tests: 24 Python, 39 vitest; end-to-end `scripts/check_analysis.py`.
- [ ] Not done: raster-vs-velocity scatter for a user raster (moved to Phase 3, needs full-resolution values); asc/desc swipe preset (GeoLibre swipe plugin works on the Layers panel entries; needs both directions as separate layers).

### Phase 1e: Download a subset of DISP-S1 and prepare it (requested 2026-10-03)

Goal: from the plugin, pick an area (drawn shape, selection or current view), dates and directions;
the server downloads only that subset with opera-utils and prepares it for
- **bowser**: a pyramided GeoZarr cube (`bowser setup-disp-s1` → `bowser tifs-to-geozarr`), served by `bowser run`;
- **GeoLibre**: GeoTIFFs (COGs) added to the map (velocity, temporal coherence, last cumulative displacement; optionally every epoch for the Time Slider).

Design:
- Jobs run on this server under disp-proxy: `POST /jobs`, `GET /jobs`, `GET /jobs/{id}` (status, log), `GET /jobs/{id}/files/...`.
- Steps per job: frames covering the area (ASF `/frame_intersection`) → `opera_utils.disp.run_download(frame, dates, bbox)` per frame → `reformat_stack` (rebased, recommended mask, optional SET/iono corrections) → outputs.
- Environment: `Portal/jobs-env` (conda-forge GDAL + editable local opera-utils and bowser); Earthdata login from `~/.netrc`.
- Plugin: "Download & prepare" section and a jobs list with progress, "Add to map" (GeoTIFF via `addCogLayer`) and "Open in bowser".

Built 2026-10-03 (GeoZarr only for now; GeoTIFF later; bowser kept out of this repo):
- [x] `jobs-env` (conda-forge GDAL + editable local opera-utils; no bowser).
- [x] `disp_portal/prepare.py` runner: frames from ASF `/frame_intersection` → `opera_utils.disp.run_download` (subset only) → `reformat_stack` (SET on, iono off by default) → GeoZarr per frame and direction; `status.json` progress.
- [x] `disp_portal/geozarr.py`: multiscale GeoZarr (Zarr v3) with displacement, short-wavelength displacement, velocity, velocity σ, valid epochs, average coherence, water mask; `spatial:`/`proj:`/`multiscales` conventions via geozarr-toolkit, validated. Transform from coordinates (the stored GeoTransform is for the full frame).
- [x] Proxy job API (`disp_portal/jobs.py`): POST/GET/cancel/DELETE `/jobs`, files at `/jobs/{id}/files/...`; area limit 2,500 km², 2 concurrent runners, runners survive proxy restarts.
- [x] Plugin: "Download subset (DISP-S1)" (drawn shape / selection / view, dates, directions, corrections) and "OPERA DISP downloads" window (progress, cancel, delete, "Show velocity" as a GeoLibre Zarr layer, "Copy path").
- [x] Measured: 4 km², 3 frames, Q1 2023 in 61 s; 12 km², 1 frame in 30 s.
- [x] Also (user suggestions): Earthdata loading banner/spinners in the time-series window; time-series points listed in the Layers tab.
- [x] Tests: 30 Python (job manager with a stub runner), 54 vitest; end-to-end `scripts/check_downloads.py`.
- [x] opera-utils: pixi configuration added to its `pyproject.toml` (default/test/docs; 304 tests pass).
- [x] GeoTIFF/COG export (`disp_portal/export.py`, option per job): velocity, σ, coherence, last displacement, optionally every epoch; COGs made with GDAL Translate (rioxarray's COG driver wrote all-zero files with rasterio 1.5); GeoLibre COG layers with `coolwarm` (blue negative, red positive). Regression test `tests/test_geozarr_export.py` (run with jobs-env).
- [x] Job clean-up: finished jobs older than 30 days, then oldest finished while over 20 GB (`DISP_JOBS_MAX_AGE_DAYS`, `DISP_JOBS_MAX_TOTAL_GB`), every 10 min; `GET /jobs-usage`; shown in the downloads window.
- [ ] Later: mosaicking overlapping frames into one cube; bowser integration outside this repo; time series from the downloaded cubes (Phase 2).

### Phase 2a: Time series from downloaded cubes (done 2026-10-03)

- [x] Proxy `POST /cubes/timeseries` (point: nearest pixel, polygon: pixel mean) and `GET /cubes/coverage`, reading the GeoZarr cubes of finished jobs (`disp_portal/cubes.py`); identical re-downloads de-duplicated (newest wins).
- [x] Plugin: every pick also fetches cube series; chart "Source" (ASF + cubes / ASF / cubes) and "Cube" (full or short-wavelength displacement); cube series drawn as lines; model fit, reference subtraction (same frame), residuals and CSV (`source`, `variable` columns) work for both.
- [x] UX (user requests, v0.2.0): time-series mode map button (off by default, crosshair when on); "Draw polygon" (GeoLibre GeoEditor) and "Annotations" buttons; "Search" box (Nominatim / lat,lon) with "+ point"; explicit "Output: GeoZarr cube / GeoTIFF / every epoch"; plugin version shown; Annotations default-active and GeoLibre search panel in project links; plugin files served `no-cache`.
- [x] Fixed: chart kept the x-range of the first series to arrive (cube) instead of the full range; zoom is now kept only after a user zoom.
- [x] Tests: 31 Python + 3 jobs-env, 57 vitest; `scripts/check_ux.py` plus all earlier end-to-end checks.

### Phase 2b: Analysis on downloaded cubes, persistent points (done 2026-10-03)

- [x] Proxy `POST /cubes/analyze` (`cubes.analyze_features`): per-feature statistics of the cubes' float velocity (full-displacement fit, no clipping/quantization) with median σ; newest cube containing the feature, else intersecting; features outside cubes reported. Shared helpers in `disp_portal/stats.py`.
- [x] Plugin "Analyze layer → Velocity from: ASF overview tiles / downloaded cubes"; cube hotspots also need |median| ≥ 2σ (`not_significant` attribute otherwise); σ column and attributes (`*_stderr_mmyr`, `*_frame`).
- [x] Analysis results styled on the map (graduated `vel_mmyr`, 7 classes) plus a red "hotspots ≥ N mm/yr" layer; "Drawn shapes" source; messages give the largest value when nothing passes.
- [x] Time-series points saved with projects (`picks`, `referencePick` in the plugin state) and kept across reloads in the browser (localStorage); GeoLibre's own autosave is crash recovery only.
- [x] Tests: 31 Python + 4 jobs-env, 65 vitest; `scripts/check_phase2b.py`.

### Phase 2c: Static layers, frame merge, vertical/east decomposition (done 2026-10-03)

- [x] opera-utils: `opera_utils.disp._static` (`search_static`, `download_static`): CMR search of `OPERA_L3_DISP-S1-STATIC_V1` by frame and windowed HTTPS/S3 reads of `line_of_sight_enu`, `dem`, `layover_shadow_mask` (only the job area). Uncommitted in the opera-utils checkout.
- [x] Jobs download the line-of-sight layer per frame (`static/<frame>/`), then `disp_portal/combine.py` puts every cube on one 30 m UTM grid of the job area:
  - merge per direction: frames aligned by the median velocity offset in their overlap (≥ 50 px), averaged with 1/σ² weights; empty frames reported;
  - decomposition where asc and desc both exist: per-pixel 2×2 solve for east and up (north neglected), σ propagated, |det| < 0.2 masked.
- [x] Outputs `out/combined/{asc,desc}_velocity[_sigma].tif`, `{vertical,east}_velocity[_sigma].tif` (COG) and `status.combined` (merge offsets, decomposition summary). Request option `combine` (default on; "merge + vertical/east" in the plugin).
- [x] Plugin jobs window: "Combined" block with COG buttons and the merge/decomposition summary.
- [x] Verified on `jobs/test-combine` (Houston 2 km box, 2023, F08882 asc + F38238/F38239 desc): 90 % of the area decomposed. Tests: 35 Python + 8 jobs-env, 67 vitest; `scripts/check_combined.py`.
- [ ] Not yet: merged/decomposed time series (only velocity); north-component sensitivity check; cross-track (different relative orbit) alignment beyond a constant offset.

### Sidebar redesign (plugin v0.3.0, 2026-10-04)

- [x] Collapsible cards (open state remembered per browser), connection header, switches, Ascending/Descending segmented control, checkbox pills, label/control grid for settings, filled primary buttons; light and dark.
- [x] Fewer sections: Identify + Basemap + Frames -> "Map"; proxy URL -> "Settings"; duplicate "Draw polygon" removed from Time series; long help moved to tooltips.
- [x] `ui.ts` (card, switchRow, segmented, field, stackedField, button); check scripts open collapsed cards (`open_card`).

### Phase 2: Own velocity and time-series service (3–4 weeks)

**Decisions (2026-10-03):** all CONUS frames; compute locally (aurora); time-series cubes at 90 m for CONUS, 30 m only for the Houston pilot.

**Sizing (measured 2026-10-03):** 918 North-America land frames in the CONUS box, ~84 % with products (~770 frames); ~190 granules / ~76 GB of NetCDF per frame, ~58 TB in total. ASF HTTPS: 23 MB/s per stream, 144 MB/s with 16 parallel streams (~5 days for CONUS). Remote h5py reads of one variable are 5x slower than whole-file downloads. opera-utils `run_download` holds each file in memory and re-encodes it (~4 GB per worker; 137 GB for 2 frames x 16 workers), so whole frames use a streaming downloader instead.

**2a. Velocity products** (`disp_portal/products.py`, `python -m disp_portal.products {catalog,frame,run,status}`)
- [x] Region catalogue with CMR granule counts (`catalog_<region>.json`).
- [x] Per-frame pipeline: streaming download (resumable `.part`) -> reformat_stack (SET) -> velocity fit at 30 m (dask blocks, 8 threads) -> COGs (velocity, σ, epochs, coherence) -> GeoZarr cube at 90 m (+30 m with `--full-res-cube`) -> static LOS -> scratch removed. Resumable (`frame.json` state), one process per frame, peak RSS recorded.
- [x] `write_geozarr` lazy path for whole frames (`coarsen`, `variables`, precomputed `fit`); levels written from the level before, read back.
- [x] Proxy `GET /products`, `GET /products/files/<path>`; product cubes feed `/cubes/timeseries` and `/cubes/analyze`. Plugin "Velocity products" window (per-frame COGs, "add all asc/desc").
- [ ] Houston pilot (6 frames: 8882, 8883, 36268, 36269 asc; 38238, 38239 desc): time, peak memory, output size -> CONUS parallelism.
- [ ] CONUS run.
- [ ] Run the opera-utils-batch `fit-local` (or our own fork) for the chosen frames to produce velocity, stderr, n_obs and temporal coherence.
- [ ] Mosaic per direction with the opera-utils-batch offset merge, or serve per-frame layers.
- [ ] Convert to COGs (EPSG:3857, float32, DEFLATE, overviews, NaN nodata, no clip). Write a STAC or JSON catalogue.
- [ ] Optional: cal-disp calibrated velocity as an extra layer.

**2b. Own time-series API**
- [ ] FastAPI service on kerchunk or Icechunk virtual references, built with the opera-utils-batch `build_virtual_reference` approach.
- [ ] Same request and response shape as ASF `/timeseries`, plus options: `frame` (choose among overlapping frames), `layer` (full or short-wavelength), `corrections` (ionosphere, SET), `mask`, `aggregate` (mean or pixels), `stderr`.
- [ ] Check the short-wavelength caveat: Corcoran shows +15–18 mm/yr in the overview; compare with full `displacement`.
- [ ] Re-referencing across ministacks with `opera_utils.disp` rebase. Optional spatial reference point.
- [ ] Deploy in us-west-2, next to the ASF S3 bucket. Handle Earthdata credentials.

**2c. Switch the plugin to our backends**
- [ ] `services` interface with ASF and own implementations, selectable in settings.
- [ ] Layers switch to `addCogLayer` on our COGs. Identify and stats switch to `readRasterWindow`, which gives full-resolution float values.
- [ ] Compare ASF and own results side by side (swipe, differencing).

### Phase 3: Full analysis on float data (1–2 weeks)

- [x] Zonal stats with σ from downloaded cubes (2σ significance for hotspots) — Phase 2b. Weighting by 1/σ² not yet.
- [ ] Raster vs velocity: resample the user raster to the velocity grid, then a scatter plot with Pearson and Spearman r. Whitebox raster algebra.
- [ ] Hotspot polygonize (Whitebox), intersected with the user's infrastructure layer.
- [x] Asc + desc decomposition to vertical and east-west where both exist — Phase 2c (DISP-S1-STATIC line of sight).
- [ ] Workflow docs: wells vs subsidence, levees and pipelines, groundwater head raster vs velocity.

### Self-hosted GeoLibre (done 2026-10-03, pulled forward from Phase 4)

- [x] `scripts/build_geolibre.sh`: GeoLibre web build (pinned commit) with OPERA DISP as a bundled drop-in (`activeByDefault`), served by disp-proxy at `/`.
- [x] `/deployment.json` (default-active, app name, no welcome), kill-switch `/sw.js`, `/project.json` without manifest when self-hosted.
- [x] `scripts/ensure_proxy.sh` watchdog (cron install left to the user). `scripts/check_selfhosted.py`.
- Reason: on GeoLibre web the plugin depends on the `?url=` project link, the trust prompt and Chrome's local-network permission; users lost it on reload.

### Phase 4: Packaging and docs

- [ ] Build the plugin zip and `plugin.json`, publish the manifest URL.
- [ ] Preset project `opera-disp.geolibre.json`.
- [ ] Optional self-hosted GeoLibre web build with the plugin in `public/plugins/`. Add the proxy and COG hosts to the Tauri CSP for a desktop build.
- [ ] README: install, configuration, data catalogue format, and the limitations of each backend.

---

## 6. Decisions

Made:
- **2026-10-03:** the proxy runs locally on this machine for Phase 1.
- **2026-10-03:** Phase 1 reuses ASF portal assets (tiles via our proxy, ASF time-series API). Our own velocity fits and time-series service come in Phase 2. No opera-utils-batch fits are available on S3 today.

Open:
1. **ASF CORS:** ask ASF to add our origin to the tile CORS allowlist. That would remove the need for `/tiles` and `/raw` in the proxy.
2. **Phase 2 frame scope** and compute (AWS Batch with batchkit, or local).
3. **Phase 2 data access:** a public bucket with CORS, or behind Earthdata login.

## 7. Risks

| Risk | Mitigation |
|---|---|
| ASF APIs and tiles are undocumented and may change or be rate-limited | proxy cache, polite concurrency, `services` interface; Phase 2 replaces them |
| Proxying ASF tiles is outside their intended use | ask ASF (decision 2); attribute ASF and OPERA in the legend |
| Decoded tile values are quantized and clipped | label results; Phase 2 float COGs |
| ASF tiles may be stale (`extent.json` last modified 2025-11-11) | show the date in the legend; Phase 2 own products |
| Polygon time-series calls are slow (about 14 s) | cache, cancel, batch limits |
| GeoLibre plugin API changes | pin the version in the manifest; test against releases |
| Desktop CSP blocks a new host | use the web build, or a self-built desktop app with the host allowlisted |

## 8. References

- ASF portal frontend bundle: `main-*.js` (`setDisplacementOverview`, `getTimeSeries`)
- https://github.com/ASFHyP3/OPERA-DISP-TMS
- https://github.com/opera-adt/opera-utils-batch
- https://github.com/opengeos/GeoLibre (`docs/plugin-api.md`, `packages/plugins/src/plugins/time-slider-pixel-series.ts`)
- https://github.com/opengeos/geolibre-plugin-template
- Scratch analysis: `/u/aurora-r0/govorcin/tmp/asfdisp/` (bundles, repo clones, sample `ts.json` and `tspoly.json`)

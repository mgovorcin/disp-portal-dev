# OPERA DISP plugin

What the OPERA DISP panel does in GeoLibre, and how to build and test it.

### GeoLibre plugin

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

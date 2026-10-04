# Running locally

The full portal runs on your machine with `disp-proxy` (FastAPI): full-resolution ASF velocity overview, identify, layer analysis, subset downloads and products. See [plugin.md](plugin.md) for the viewer features and [downloads-and-products.md](downloads-and-products.md) for server-side processing.

### Layout

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
notebooks/                  prototype notebook (ASF tiles and time-series API)
tests/                      offline unit tests
```

### Setup

```bash
pixi run server                                   # or: uv sync && .venv/bin/disp-proxy --port 8790
pixi run test
.venv/bin/python scripts/validate_decoder.py       # network, about 1 min
```

### disp-proxy

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

### GeoLibre with OPERA DISP (self-hosted)

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

#### Keep the proxy running

Processes started from an editor or terminal session stop with it. `scripts/ensure_proxy.sh` starts the
proxy detached if `/health` does not answer; run it from cron to keep it up (your choice):

```bash
(crontab -l; echo "* * * * * /path/to/disp-portal-dev/scripts/ensure_proxy.sh") | crontab -
```

#### If the plugin is missing in GeoLibre

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

### Quick use

```python
from disp_portal import AsfClient, mosaic, value_at

df = AsfClient().timeseries((-95.37, 29.76), "ascending")   # tidy DataFrame, one row per epoch
v = value_at(-95.37, 29.76, "ascending")                      # decoded overview velocity, m/yr
da = mosaic((-96.0, 29.4, -94.9, 30.3), "ascending", z=11)    # EPSG:3857 xarray grid
```

Tiles are cached under `.cache/tiles/` when a `TileFetcher(cache_dir=...)` is used.

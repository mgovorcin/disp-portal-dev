# GitHub Pages build

How the static demo at <https://mgovorcin.github.io/disp-portal-dev/> is built.

### GitHub Pages build

`scripts/build_pages.sh [/disp-portal-dev/] [dist-pages]` builds GeoLibre (pinned in
[GEOLIBRE_COMMIT](../GEOLIBRE_COMMIT)) with the plugin and branding under the site's URL path, then
writes the static site files (`scripts/write_pages_static.py`): plugin site config
(`disp-portal.json`), public-use basemaps (OpenFreeMap, OpenStreetMap, EOX Sentinel-2 cloudless),
the demo project, `deployment.json` and a service-worker kill switch. `scripts/mirror_overview_tiles.py`
mirrors the ASF velocity overview (z2–10 as WebP, ~0.55 GB) into the site, because ASF's tile server only
allows its own portal to read the tiles from a browser. The
[Pages workflow](../.github/workflows/pages.yml) runs it on every push to `main`.

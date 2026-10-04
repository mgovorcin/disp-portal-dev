#!/usr/bin/env bash
# Static GitHub Pages build: GeoLibre + OPERA DISP plugin + branding under the repo's URL path,
# plus the static site files (scripts/write_pages_static.py). No disp-proxy behind it.
#
#   scripts/build_pages.sh [/disp-portal-dev/] [dist-pages]
#   env: OVERVIEW_MAX_ZOOM (9), SKIP_OVERVIEW=1, MIRROR_DIR, PYTHON
set -euo pipefail
PORTAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${1:-/disp-portal-dev/}"
OUT="$(realpath -m "${2:-$PORTAL/dist-pages}")"
PYTHON="${PYTHON:-python3}"
# Mirrored ASF overview tiles live outside the GeoLibre output (the Vite build empties it);
# MIRROR_DIR is cached between CI runs.
MIRROR_DIR="${MIRROR_DIR:-$PORTAL/.cache/overview-mirror}"
GEOLIBRE_OUT="$OUT" GEOLIBRE_APP_BASE="$BASE" "$PORTAL/scripts/build_geolibre.sh"
if [[ "${SKIP_OVERVIEW:-0}" != "1" ]]; then
  "$PYTHON" "$PORTAL/scripts/mirror_overview_tiles.py" "$MIRROR_DIR" --max-zoom "${OVERVIEW_MAX_ZOOM:-9}"
  cp -r "$MIRROR_DIR/overview" "$OUT/overview"
fi
"$PYTHON" "$PORTAL/scripts/write_pages_static.py" "$OUT"
du -sh "$OUT"

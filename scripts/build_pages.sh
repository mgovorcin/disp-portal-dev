#!/usr/bin/env bash
# Static GitHub Pages build: GeoLibre + OPERA DISP plugin + branding under the repo's URL path,
# plus the static site files (scripts/write_pages_static.py). No disp-proxy behind it.
#
#   scripts/build_pages.sh [/disp-portal-dev/] [dist-pages]
set -euo pipefail
PORTAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${1:-/disp-portal-dev/}"
OUT="$(realpath -m "${2:-$PORTAL/dist-pages}")"
GEOLIBRE_OUT="$OUT" GEOLIBRE_APP_BASE="$BASE" "$PORTAL/scripts/build_geolibre.sh"
python3 "$PORTAL/scripts/write_pages_static.py" "$OUT"
du -sh "$OUT"

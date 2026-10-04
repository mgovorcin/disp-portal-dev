#!/usr/bin/env bash
# Build a GeoLibre web app with the OPERA DISP plugin baked in, into Portal/geolibre-web/.
# disp-proxy serves it at / (so the plugin is always loaded, same origin, no prompts).
#
# Prerequisite once:  git clone https://github.com/opengeos/GeoLibre.git vendor/GeoLibre
#                     (cd vendor/GeoLibre && npm ci --ignore-scripts)
# Then:               scripts/build_geolibre.sh        (restart disp-proxy afterwards)
# Plugin changes only: scripts/build_geolibre.sh --plugin-only   (seconds; GeoLibre loads the
#                     baked-in plugin from plugins/opera-disp/ at runtime, so no rebuild needed)
#
# Skipped on purpose: GeoLibre's JupyterLite bundle (Notebook panel), which needs a Python
# build of its own; everything else works.
set -euo pipefail
PORTAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GL="$PORTAL/vendor/GeoLibre"
APP="$GL/apps/geolibre-desktop"
# Overridable for the GitHub Pages build (scripts/build_pages.sh): output dir and URL base path.
OUT="${GEOLIBRE_OUT:-$PORTAL/geolibre-web}"
APP_BASE="${GEOLIBRE_APP_BASE:-/}"
GEOLIBRE_COMMIT="$(cat "$PORTAL/GEOLIBRE_COMMIT")"
# Big scratch disk on the development machine (/tmp there is tiny); CI uses its defaults.
if [[ -d /u/aurora-r0/govorcin/tmp ]]; then
  export TMPDIR=/u/aurora-r0/govorcin/tmp npm_config_cache=/u/aurora-r0/govorcin/tmp/npm-cache
fi
if [[ ! -d "$GL" ]]; then
  echo "== clone GeoLibre $GEOLIBRE_COMMIT -> $GL"
  git clone --filter=blob:none https://github.com/opengeos/GeoLibre.git "$GL"
  git -C "$GL" checkout --quiet "$GEOLIBRE_COMMIT"
  (cd "$GL" && npm ci --ignore-scripts)
fi

echo "== plugin"
(cd "$PORTAL/plugin" && npm run build --silent)

echo "== bundle plugin into GeoLibre public/plugins (activeByDefault)"
DEST="$APP/public/plugins/opera-disp"
rm -rf "$DEST"
mkdir -p "$DEST/dist"
cp "$PORTAL/plugin/geolibre-plugin/dist/index.js" "$PORTAL/plugin/geolibre-plugin/dist/style.css" "$DEST/dist/"
python3 - "$PORTAL/plugin/geolibre-plugin/plugin.json" "$DEST/plugin.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["activeByDefault"] = True
json.dump(manifest, open(sys.argv[2], "w"), indent=2)
PY

# OPERA branding (branding/*.css|js) injected into index.html; idempotent, works for both modes.
inject_branding() {
  rm -rf "$OUT/branding" && cp -r "$PORTAL/branding" "$OUT/branding"
  python3 - "$OUT/index.html" "$APP_BASE" <<'PY'
import sys
path = sys.argv[1]
html = open(path).read()
base = sys.argv[2]
tags = (f'<link rel="stylesheet" href="{base}branding/branding.css" />'
        f'<script src="{base}branding/branding.js" defer></script>')
if "branding/branding.css" not in html:
    html = html.replace("</head>", tags + "</head>", 1)
    open(path, "w").write(html)
PY
}

if [[ "${1:-}" == "--plugin-only" ]]; then
  [[ -f "$OUT/index.html" ]] || { echo "no GeoLibre build in $OUT; run without --plugin-only first" >&2; exit 1; }
  rm -rf "$OUT/plugins/opera-disp"
  mkdir -p "$OUT/plugins"
  cp -r "$DEST" "$OUT/plugins/opera-disp"
  inject_branding
  echo "updated $OUT/plugins/opera-disp and branding (reload the browser tab)"
  exit 0
fi

echo "== GeoLibre dependency patches + embed package"
(cd "$GL" && npm run postinstall --silent && npm run build -w @geolibre/embed --silent)

echo "== GeoLibre web build -> $OUT"
(cd "$APP" && VITE_WELCOME_DISABLED=1 VITE_GEOLIBRE_APP_NAME="OPERA DISP Portal" GEOLIBRE_APP_BASE="$APP_BASE" \
  npx vite build --outDir "$OUT" --emptyOutDir)

inject_branding

{
  echo "GeoLibre commit: $(git -C "$GL" rev-parse HEAD)"
  echo "Plugin version: $(python3 -c "import json;print(json.load(open('$DEST/plugin.json'))['version'])")"
  echo "Built: $(date -Is)"
} > "$OUT/BUILD_INFO.txt"
cat "$OUT/BUILD_INFO.txt"
du -sh "$OUT"

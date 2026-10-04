"""Static files for the GitHub Pages build (no disp-proxy behind the site).

Writes into the built GeoLibre directory:

- ``disp-portal.json``  site config read by the OPERA DISP plugin: static mode, basemaps, demo project,
  and the mirrored velocity overview when ``<out>/overview`` exists (scripts/mirror_overview_tiles.py)
- ``basemaps/*.json``   raster basemap styles (vector ones point straight at OpenFreeMap)
- ``demo/context-layers.geolibre``  roads / geology / 3D buildings demo project
- ``deployment.json``   GeoLibre deployment policy (OPERA DISP and Annotations on, app name)
- ``sw.js``             service-worker kill switch (GeoLibre's offline cache would pin old builds)
- ``.nojekyll``         serve files as-is

Only basemaps whose terms allow use from a public site are listed (OpenFreeMap, OpenStreetMap
standard tiles for light use, EOX Sentinel-2 cloudless); the Esri/Google basemaps of the local
proxy are left out.

Usage:
    python scripts/write_pages_static.py dist-pages
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_demo_project

OPENFREEMAP = "https://tiles.openfreemap.org/styles"

KILL_SWITCH_SW = """
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
"""

RASTER = {
    "osm": {
        "name": "OpenStreetMap",
        "tiles": ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        "attribution": "© OpenStreetMap contributors",
        "maxzoom": 19,
    },
    "satellite": {
        "name": "Satellite (Sentinel-2 cloudless 2023, EOX)",
        "tiles": ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg"],
        "attribution": "Sentinel-2 cloudless 2023 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)",
        "maxzoom": 15,
    },
}
VECTOR = {
    "light": ("Light (OpenFreeMap Positron)", f"{OPENFREEMAP}/positron"),
    "dark": ("Dark (OpenFreeMap)", f"{OPENFREEMAP}/dark"),
    "liberty": ("Streets (OpenFreeMap Liberty)", f"{OPENFREEMAP}/liberty"),
}
OPENFREEMAP_ATTRIBUTION = "OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors"


def raster_style(key: str, b: dict) -> dict:
    return {
        "version": 8,
        "name": b["name"],
        "sources": {key: {"type": "raster", "tiles": b["tiles"], "tileSize": 256, "maxzoom": b["maxzoom"],
                          "attribution": b["attribution"]}},
        "layers": [{"id": key, "type": "raster", "source": key}],
    }


def overview_maxzoom(out: Path) -> int:
    """Highest zoom present in the mirrored overview (scripts/mirror_overview_tiles.py)."""
    zooms = [int(p.name) for p in (out / "overview" / "asc" / "vel").iterdir() if p.name.isdigit()]
    return max(zooms) if zooms else 9


def write(out: Path) -> None:
    basemaps = []
    for key, (name, url) in VECTOR.items():
        basemaps.append({"key": key, "name": name, "attribution": OPENFREEMAP_ATTRIBUTION, "maxzoom": 20,
                         "tiles": [], "labels": None, "style_url": url})
    (out / "basemaps").mkdir(parents=True, exist_ok=True)
    for key, b in RASTER.items():
        (out / "basemaps" / f"{key}.json").write_text(json.dumps(raster_style(key, b), indent=1))
        basemaps.append({"key": key, "name": b["name"], "attribution": b["attribution"], "maxzoom": b["maxzoom"],
                         "tiles": b["tiles"], "labels": None, "style_url": f"basemaps/{key}.json"})

    demo = build_demo_project.build("2026-09-23.1")
    demo["basemapStyleUrl"] = VECTOR["dark"][1]
    (out / "demo").mkdir(exist_ok=True)
    (out / "demo" / "context-layers.geolibre").write_text(json.dumps(demo, indent=1))

    (out / "disp-portal.json").write_text(json.dumps({
        "mode": "static",
        "note": "In development; not an official OPERA, JPL or NASA product.",
        "basemaps": basemaps,
        "demoProject": "demo/context-layers.geolibre",
        **({"overview": {"tiles": "overview/{dir}/vel/{z}/{x}/{y}.png", "extent": "overview/{dir}/extent.json",
                         "maxzoom": overview_maxzoom(out)}} if (out / "overview").is_dir() else {}),
    }, indent=1))
    (out / "deployment.json").write_text(json.dumps({
        "version": 1,
        "plugins": {"defaultActive": ["opera-disp", "maplibre-gl-annotations"]},
        "branding": {"appName": "OPERA DISP Portal", "welcome": False},
    }, indent=1))
    (out / "sw.js").write_text(KILL_SWITCH_SW)
    (out / ".nojekyll").write_text("")
    print(f"static files written to {out}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    write(args.out)


if __name__ == "__main__":
    main()

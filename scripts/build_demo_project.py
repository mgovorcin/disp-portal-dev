"""Build the "context layers" demo project: roads, geology WMS, 3D buildings (GeoLibre format).

Uses GeoLibre's own Python project builders (vendor/GeoLibre/python), so the layers are the same
records the Add Data dialogs create:

- Roads: Overture Maps transportation PMTiles, source layer ``segment`` (vector PMTiles)
- Geology: USGS State Geologic Map Compilation WMS, layer ``sgmc`` (tiled GetMap)
- 3D buildings: Overture Maps buildings PMTiles, source layer ``building``, extruded by ``height``
  (falls back to ``num_floors`` x 3.5 m, then 4 m)

The basemap URL keeps the placeholder ``__BASE__``; disp-proxy fills in its own origin when it
serves ``/demo/context-layers.geolibre``.

Usage:
    python scripts/build_demo_project.py [--release 2026-09-23.1] [--out demo/context-layers.geolibre]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEOLIBRE_PY = ROOT / "vendor" / "GeoLibre" / "python" / "src" / "geolibre"


def _load_geolibre_project():
    """Load geolibre/project.py (stdlib + its basemaps.py only) without the package __init__,
    which pulls in the Jupyter widget (anywidget)."""
    import importlib.util
    import types

    pkg = types.ModuleType("geolibre")
    pkg.__path__ = [str(GEOLIBRE_PY)]
    sys.modules.setdefault("geolibre", pkg)
    for name in ("basemaps", "project"):
        spec = importlib.util.spec_from_file_location(f"geolibre.{name}", GEOLIBRE_PY / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"geolibre.{name}"] = module
        spec.loader.exec_module(module)
    return sys.modules["geolibre.project"]


_gp = _load_geolibre_project()
DEFAULT_LAYER_STYLE = _gp.DEFAULT_LAYER_STYLE
build_empty_project, pmtiles_layer, set_plugin_state, wms_layer = (
    _gp.build_empty_project, _gp.pmtiles_layer, _gp.set_plugin_state, _gp.wms_layer)

OVERTURE = "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/{release}/{theme}.pmtiles"
USGS_SGMC = "https://mrdata.usgs.gov/services/sgmc2"

# Height (m): Overture height, else floors x 3.5 m, else 4 m. (`to-number` of a missing value is 0
# in MapLibre, so test with `has` instead of coalescing.)
HEIGHT_EXPR = [
    "case",
    ["has", "height"], ["max", ["to-number", ["get", "height"], 4], 2],
    ["has", "num_floors"], ["*", ["to-number", ["get", "num_floors"], 1], 3.5],
    4,
]
# Colour by height: low-rise pale, towers OPERA teal.
COLOR_EXPR = [
    "interpolate", ["linear"], HEIGHT_EXPR,
    0, "#e6f4f1",
    20, "#90d0c0",
    60, "#10b0b0",
    150, "#007570",
    300, "#0b3b39",
]


def native_ids(layer: dict, source_layer: str) -> dict:
    """GeoLibre names a vector PMTiles layer's MapLibre layers ``<id>-<source layer>-{fill,line,circle}``.
    Its extrusion step looks them up by these ids, so record them (the builder stores a placeholder)."""
    ids = [f"{layer['id']}-{source_layer}-{kind}" for kind in ("fill", "line", "circle")]
    layer["metadata"]["nativeLayerIds"] = ids
    return layer


def hidden_velocity_entry(opacity: float) -> dict:
    """Layers-panel entry for the OPERA DISP velocity overlay, saved hidden. The plugin re-registers
    the layer on load and GeoLibre keeps an existing entry's visibility (new ones start visible)."""
    lid = "opera-disp-velocity"
    return {
        "id": lid,
        "name": "OPERA DISP velocity (ASF overview)",
        "type": "raster",
        "source": {"type": "geojson", "sourceId": lid},
        "visible": False,
        "opacity": opacity,
        "style": dict(DEFAULT_LAYER_STYLE),
        "metadata": {"plugin": "opera-disp", "units": "m/yr", "externalNativeLayer": True,
                     "nativeLayerIds": [lid], "sourceIds": [lid], "sourceId": lid, "paintMode": "plugin"},
    }


def build(release: str) -> dict:
    project = build_empty_project("OPERA DISP demo: roads, geology, 3D buildings", center=[-95.3698, 29.7570], zoom=15.2)
    project["mapView"].update({"pitch": 60, "bearing": -25})
    project["basemapStyleUrl"] = "__BASE__/basemaps/dark.json"

    geology = wms_layer(
        "Geology (USGS State Geologic Map Compilation)",
        USGS_SGMC,
        "sgmc",
        attribution="USGS State Geologic Map Compilation (SGMC)",
    )
    geology["opacity"] = 0.55

    roads = pmtiles_layer(
        "Roads (Overture transportation)",
        OVERTURE.format(release=release, theme="transportation"),
        source_layers=["segment"],
        strokeColor="#f2a541",
        strokeWidth=1.6,
        fillOpacity=0,
        circleRadius=0,
    )
    native_ids(roads, "segment")
    roads["metadata"]["attribution"] = "© Overture Maps Foundation, OpenStreetMap contributors"

    buildings = pmtiles_layer(
        "3D buildings (Overture)",
        OVERTURE.format(release=release, theme="buildings"),
        source_layers=["building"],
        fillColor="#4aa3df",
        extrusionEnabled=True,
        extrusionColor="#4aa3df",
        extrusionOpacity=0.9,
        extrusionHeightProperty="height",
        extrusionBase=0,
        extrusionAdvancedStyleEnabled=True,
        extrusionHeightExpression=json.dumps(HEIGHT_EXPR),
        extrusionColorExpression=json.dumps(COLOR_EXPR),
        minZoom=13,
    )
    native_ids(buildings, "building")
    buildings["metadata"]["attribution"] = "© Overture Maps Foundation"

    # OPERA DISP: velocity overview off (toggle it on to compare), dark basemap, no frame outlines.
    set_plugin_state(project, "opera-disp", {"visible": False, "basemap": "dark", "showFrames": False, "opacity": 0.6})
    # Bottom to top in the Layers panel order GeoLibre uses (first = bottom).
    project["layers"] = [geology, roads, buildings, hidden_velocity_entry(0.6)]
    project["metadata"] = {
        **project.get("metadata", {}),
        "description": "Context layers for OPERA DISP: Overture roads and 3D buildings (PMTiles), USGS geology (WMS).",
        "overture_release": release,
    }
    return project


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", default="2026-09-23.1", help="Overture tiles release (s3 prefix)")
    parser.add_argument("--out", type=Path, default=ROOT / "demo" / "context-layers.geolibre")
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(build(args.release), indent=1))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

"""Raster basemaps that need no API key, shared by the test viewer and the GeoLibre plugin.

Terms: Esri (server.arcgisonline.com) and Google (mt*.google.com) tiles are used here
for a local research prototype. Their terms restrict direct tile access in public
applications (GeoLibre itself leaves them out of its catalogue for that reason), so
review them, or switch to licensed endpoints, before deploying publicly.
"""

from __future__ import annotations

ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services"
ESRI_ATTRIBUTION = "Esri, HERE, Garmin, © OpenStreetMap contributors"

BASEMAPS: dict[str, dict] = {
    "light": {
        "name": "Light",
        "maxzoom": 16,
        "attribution": ESRI_ATTRIBUTION,
        "tiles": [f"{ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{{z}}/{{y}}/{{x}}"],
        "labels": [f"{ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{{z}}/{{y}}/{{x}}"],
        "background": "#e5e5e5",
    },
    "dark": {
        "name": "Dark",
        "maxzoom": 16,
        "attribution": ESRI_ATTRIBUTION,
        "tiles": [f"{ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{{z}}/{{y}}/{{x}}"],
        "labels": [f"{ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{{z}}/{{y}}/{{x}}"],
        "background": "#262626",
    },
    "osm": {
        "name": "OpenStreetMap",
        "maxzoom": 19,
        "attribution": "© OpenStreetMap contributors",
        "tiles": ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        "background": "#f2efe9",
    },
    "satellite": {
        "name": "Satellite (Google)",
        "maxzoom": 20,
        "attribution": "Imagery © Google",
        "tiles": [f"https://mt{i}.google.com/vt/lyrs=s&x={{x}}&y={{y}}&z={{z}}" for i in range(4)],
        "background": "#000000",
    },
    "hybrid": {
        "name": "Satellite hybrid (Google)",
        "maxzoom": 20,
        "attribution": "Imagery © Google",
        "tiles": [f"https://mt{i}.google.com/vt/lyrs=y&x={{x}}&y={{y}}&z={{z}}" for i in range(4)],
        "background": "#000000",
    },
}


def style_json(key: str) -> dict:
    """A MapLibre style with the basemap as its only raster layer (labels are a separate overlay)."""
    b = BASEMAPS[key]
    return {
        "version": 8,
        "name": b["name"],
        "sources": {
            "basemap": {
                "type": "raster",
                "tiles": b["tiles"],
                "tileSize": 256,
                "maxzoom": b["maxzoom"],
                "attribution": b["attribution"],
            }
        },
        "layers": [
            {"id": "background", "type": "background", "paint": {"background-color": b["background"]}},
            {"id": "basemap", "type": "raster", "source": "basemap"},
        ],
    }

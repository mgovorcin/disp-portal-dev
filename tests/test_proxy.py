import io

import mercantile
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from disp_portal import proxy
from disp_portal.tiles import COLOR_LUT, decode, lonlat_to_pixel

VEL = (-0.03, 0.03)
COVERED = mercantile.tile(-95.4, 29.75, 12)


class FakeStore:
    """Zoom-12 tile COVERED: byte = column index + 1 (velocity grows west -> east); others missing."""
    async def get_array(self, direction, kind, z, x, y):
        if z != 12 or (x, y) != (COVERED.x, COVERED.y):
            return None
        byte = np.tile(np.arange(1, 257, dtype=np.int32).clip(1, 255).astype(np.uint8), (256, 1))
        alpha = np.full((256, 256), 255, np.uint8)
        alpha[:, :10] = 0
        return byte, alpha

    async def get_bytes(self, direction, kind, z, x, y):
        return None

    async def extent(self, direction, kind):
        return {"scale_range": {"range": list(VEL)}, "tile_date": "test"}

    async def scale(self, direction, kind):
        return VEL

    async def close(self):
        pass


@pytest.fixture
def client():
    with TestClient(proxy.app) as c:
        proxy.app.state.store = FakeStore()
        yield c


def _png_array(response):
    return np.asarray(Image.open(io.BytesIO(response.content)))


def test_tile_is_colourised_with_cors(client):
    r = client.get(f"/tiles/asc/vel/12/{COVERED.x}/{COVERED.y}.png", headers={"Origin": "https://web.geolibre.app"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
    rgba = _png_array(r)
    assert rgba.shape == (256, 256, 4)
    assert (rgba[:, :10, 3] == 0).all()
    assert tuple(rgba[0, 100, :3]) == tuple(COLOR_LUT[101, :3])


def test_missing_tile_is_transparent(client):
    r = client.get("/tiles/desc/vel/12/0/0.png")
    assert r.status_code == 200
    assert (_png_array(r)[..., 3] == 0).all()


def test_overzoom_cuts_parent(client):
    child = mercantile.children(COVERED)[1]  # top-right quarter
    rgba = _png_array(client.get(f"/tiles/asc/vel/13/{child.x}/{child.y}.png"))
    # column 0 of the right half of the parent is parent column 128 -> byte 129
    assert tuple(rgba[0, 0, :3]) == tuple(COLOR_LUT[129, :3])
    assert tuple(rgba[0, 1, :3]) == tuple(COLOR_LUT[129, :3])


def test_value_matches_decoder(client):
    lon, lat = -95.4, 29.75
    _, _, col, _ = lonlat_to_pixel(lon, lat, 12)
    r = client.get("/value", params={"lon": lon, "lat": lat, "dir": "asc"}).json()
    expected = float(decode(np.array([[min(col + 1, 255)]], np.uint8), None, VEL)[0, 0])
    assert r["value"] == pytest.approx(expected, abs=1e-6)
    assert r["units"] == "m/yr"


def test_value_outside_coverage_is_null(client):
    r = client.get("/value", params={"lon": 10.0, "lat": 45.0}).json()
    assert r["value"] is None


def test_stats_polygon(client):
    b = mercantile.bounds(COVERED)
    # the eastern half of the tile: columns 128..255 -> bytes 129..255
    w = b.west + (b.east - b.west) * 0.5
    poly = {"type": "Polygon", "coordinates": [[[w, b.south], [b.east, b.south], [b.east, b.north], [w, b.north], [w, b.south]]]}
    r = client.post("/stats", json={"geometry": poly, "direction": "asc", "threshold": 0.0}).json()
    assert r["n_valid"] == r["n_pixels"] > 0
    assert r["min"] > 0.0
    assert r["fraction_below_threshold"] == 0.0
    assert r["fraction_clipped"] > 0


def test_stats_rejects_points(client):
    r = client.post("/stats", json={"geometry": {"type": "Point", "coordinates": [0, 0]}})
    assert r.status_code == 422


def test_profile_increases_eastward(client):
    b = mercantile.bounds(COVERED)
    lat = (b.north + b.south) / 2
    line = {"type": "LineString", "coordinates": [[b.west + 0.0005, lat], [b.east - 0.0005, lat]]}
    r = client.post("/profile", json={"line": line, "step_m": 100}).json()
    vals = [v for v in r["values"] if v is not None]
    assert len(vals) > 5 and vals == sorted(vals)
    assert r["distance_m"][0] == 0


def test_sample_batch(client):
    r = client.post("/sample", json={"points": [[-95.4, 29.75], [10, 45]]}).json()
    assert r["values"][0] is not None and r["values"][1] is None


def test_private_network_preflight(client):
    r = client.options(
        "/value",
        headers={
            "Origin": "https://web.geolibre.app",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r.headers.get("access-control-allow-private-network") == "true"


def test_analyze_mixed_geometries(client):
    b = mercantile.bounds(COVERED)
    w = b.west + (b.east - b.west) * 0.5
    lat = (b.north + b.south) / 2
    poly = {"type": "Polygon", "coordinates": [[[w, b.south], [b.east, b.south], [b.east, b.north], [w, b.north], [w, b.south]]]}
    features = [
        {"type": "Feature", "properties": {"name": "east half"}, "geometry": poly},
        {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [-95.4, 29.75]}},
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[b.west + 0.0005, lat], [b.east - 0.0005, lat]]}},
        {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [10, 45]}},
        {"type": "Feature", "properties": {}, "geometry": None},
        {"type": "Feature", "properties": {}, "geometry": {"type": "GeometryCollection", "geometries": []}},
    ]
    r = client.post("/analyze", json={"features": features, "threshold": 0.0, "abs_threshold": 0.02, "step_m": 100}).json()
    res = r["results"]
    assert len(res) == 6
    assert res[0]["geometry_type"] == "Polygon" and res[0]["min"] > 0 and res[0]["fraction_below_threshold"] == 0.0
    # east half: bytes 129..255 -> 0..+0.03 m/yr; |v| >= 0.02 for roughly the top third
    assert 0.25 < res[0]["fraction_abs_exceeding"] < 0.4
    assert res[1]["n_valid"] == 1
    assert res[2]["geometry_type"] == "LineString" and res[2]["n_valid"] > 5 and res[2]["min"] < res[2]["max"]
    assert res[3]["n_valid"] == 0 and "mean" not in res[3]
    assert res[4]["error"] == "no geometry"
    assert "unsupported" in res[5]["error"]
    assert r["units"] == "m/yr"


def test_analyze_too_large_polygon_is_a_per_feature_error(client):
    big = {"type": "Polygon", "coordinates": [[[-100, 25], [-90, 25], [-90, 35], [-100, 35], [-100, 25]]]}
    r = client.post("/analyze", json={"features": [{"type": "Feature", "geometry": big}]}).json()
    assert "zoom-12 tiles" in r["results"][0]["error"]


def test_project_with_demo_layer(client):
    r = client.get("/project.json", params={"demo": 1, "dir": "desc"}).json()
    assert r["plugins"]["activePluginIds"] == ["opera-disp", "maplibre-gl-annotations"]
    assert r["plugins"]["settings"]["opera-disp"]["direction"] == "desc"
    (layer,) = r["layers"]
    assert layer["type"] == "geojson" and len(layer["geojson"]["features"]) >= 5
    assert client.get("/project.json").json()["layers"] == []


def test_root_redirects_to_geolibre_web_without_build(client, monkeypatch, tmp_path):
    monkeypatch.setattr(proxy, "GEOLIBRE_DIST", tmp_path / "missing")
    r = client.get("/?demo=1&basemap=dark", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"].startswith("https://web.geolibre.app/?url=http://testserver/project.json%3Fdemo%3D1")
    assert client.get("/project.json").json()["plugins"]["manifestUrls"] == ["http://testserver/plugin/plugin.json"]


def test_root_serves_self_hosted_build(client, monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<html>geolibre</html>")
    monkeypatch.setattr(proxy, "GEOLIBRE_DIST", tmp_path)
    r = client.get("/")
    assert r.status_code == 200 and "geolibre" in r.text
    r = client.get("/?demo=1", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].startswith("/?url=http://testserver/project.json%3Fdemo%3D1")
    assert client.get("/?url=/project.json").status_code == 200
    assert client.get("/project.json").json()["plugins"]["manifestUrls"] == []
    assert client.get("/deployment.json").json()["plugins"]["defaultActive"] == ["opera-disp", "maplibre-gl-annotations"]
    project = client.get("/project.json").json()
    assert project["interaction"]["controls"]["search"] is True
    assert "maplibre-gl-annotations" in project["plugins"]["activePluginIds"]
    assert "unregister" in client.get("/sw.js").text


def test_products_listing_and_files(tmp_path, monkeypatch):
    import json as _json

    from fastapi.testclient import TestClient

    from disp_portal import proxy

    products = tmp_path / "products"
    frame = products / "frames" / "F08882"
    frame.mkdir(parents=True)
    (frame / "F08882_asc_velocity.tif").write_bytes(b"tif")
    (frame / "frame.json").write_text(_json.dumps({
        "frame": 8882, "direction": "asc", "state": "done",
        "geotiffs": [{"path": "F08882_asc_velocity.tif", "kind": "velocity"}],
        "cube_90m": {"path": "products/frames/F08882/F08882_asc_90m.zarr", "time_range": ["2016-07-01", "2026-01-01"]},
    }))
    monkeypatch.setenv("DISP_PRODUCTS_DIR", str(products))
    with TestClient(proxy.app) as client:
        body = client.get("/products").json()
        assert body["frames"][0]["geotiffs"][0]["path"] == "frames/F08882/F08882_asc_velocity.tif"
        assert body["frames"][0]["cubes"] == ["frames/F08882/F08882_asc_90m.zarr"]
        assert client.get("/products/files/frames/F08882/F08882_asc_velocity.tif").content == b"tif"
        assert client.get("/products/files/frames/F08882/frame.json").status_code == 200
        assert client.get("/products/files/../../etc/passwd").status_code == 404
        assert client.get("/products/files/catalog_conus.json").status_code == 404

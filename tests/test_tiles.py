import mercantile
import numpy as np
import pytest

from disp_portal.tiles import ASF_COLOR_STOPS, COLOR_LUT, decode, encode, lonlat_to_pixel

VEL = (-0.03, 0.03)


def test_decode_endpoints_and_nodata():
    byte = np.array([[0, 1, 128, 255]], dtype=np.uint8)
    alpha = np.array([[0, 255, 255, 255]], dtype=np.uint8)
    v = decode(byte, alpha, VEL)
    assert np.isnan(v[0, 0])
    assert v[0, 1] == pytest.approx(-0.03)
    assert v[0, 2] == pytest.approx(0.0, abs=1e-6)
    assert v[0, 3] == pytest.approx(0.03)


def test_alpha_masks_valid_bytes():
    v = decode(np.array([[100]], np.uint8), np.array([[0]], np.uint8), VEL)
    assert np.isnan(v[0, 0])


def test_roundtrip_within_quantization():
    values = np.linspace(-0.05, 0.05, 1001)
    back = decode(encode(values, VEL), None, VEL)
    clipped = np.clip(values, *VEL)
    assert np.nanmax(np.abs(back - clipped)) <= 0.06 / 254 / 2 + 1e-7


def test_lut_matches_asf_stops():
    for pos, rgb in ASF_COLOR_STOPS:
        if pos <= 255:
            assert tuple(COLOR_LUT[pos, :3]) == rgb
    assert COLOR_LUT[0, 3] == 0


@pytest.mark.parametrize("lon,lat", [(-95.4, 29.75), (-119.3, 36.2), (151.2, -33.9)])
def test_lonlat_to_pixel_matches_mercantile(lon, lat):
    tx, ty, col, row = lonlat_to_pixel(lon, lat, 12)
    tile = mercantile.tile(lon, lat, 12)
    assert (tx, ty) == (tile.x, tile.y)
    b = mercantile.bounds(tile)
    assert 0 <= col < 256 and 0 <= row < 256
    assert abs((lon - b.west) / (b.east - b.west) * 256 - col) < 1.01


class _FakeFetcher:
    """Every tile has byte 128 (0 m/yr) except pixel (0, 0) = 255 (+0.03)."""

    def get(self, direction, kind, z, x, y):
        byte = np.full((256, 256), 128, np.uint8)
        byte[0, 0] = 255
        return byte, np.full((256, 256), 255, np.uint8)


def test_mosaic_georeferencing(monkeypatch):
    from disp_portal import tiles

    monkeypatch.setattr(tiles, "scale_range", lambda d, k: VEL)
    bbox = (-95.42, 29.74, -95.40, 29.76)
    da = tiles.mosaic(bbox, "asc", "vel", z=12, fetcher=_FakeFetcher())
    assert da.rio.crs.to_epsg() == 3857
    covering = list(mercantile.tiles(*bbox, zooms=12))
    ul = mercantile.xy_bounds(min(t.x for t in covering), min(t.y for t in covering), 12)
    res = (ul.right - ul.left) / 256
    assert float(da.x[0]) == pytest.approx(ul.left + res / 2)
    assert float(da.y[0]) == pytest.approx(ul.top - res / 2)
    assert float(da[0, 0]) == pytest.approx(0.03)

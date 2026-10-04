"""Frame merge and asc/desc decomposition (pure numpy; run with jobs-env or the proxy venv)."""

import numpy as np
import pytest

pytest.importorskip("rasterio")
pytest.importorskip("zarr")

from disp_portal.combine import decompose, merge_direction, target_grid


def test_decompose_recovers_east_and_up():
    shape = (5, 6)
    v_east, v_up = np.full(shape, 0.004), np.full(shape, -0.012)
    los_a = np.stack([np.full(shape, -0.62), np.full(shape, -0.12), np.full(shape, 0.77)])
    los_d = np.stack([np.full(shape, 0.60), np.full(shape, -0.12), np.full(shape, 0.79)])
    va = los_a[0] * v_east + los_a[2] * v_up
    vd = los_d[0] * v_east + los_d[2] * v_up
    sig = np.full(shape, 0.001)
    out = decompose(va, sig, los_a, vd, sig, los_d)
    assert np.allclose(out["east"], 0.004) and np.allclose(out["up"], -0.012)
    # with |e| ~ 0.6 and |u| ~ 0.8, east is less well determined than up
    assert (out["east_sigma"] > out["up_sigma"]).all()
    vd2 = vd.copy()
    vd2[0, 0] = np.nan
    assert np.isnan(decompose(va, sig, los_a, vd2, sig, los_d)["up"][0, 0])


def test_merge_aligns_frame_offset_and_weights():
    _, x = np.mgrid[0:40, 0:60]
    truth = 0.001 * (x / 60.0)
    a = np.where(x < 40, truth, np.nan)
    b = np.where(x >= 20, truth - 0.003, np.nan)  # another reference: constant offset
    sig = np.full(truth.shape, 0.001)
    merged, sigma, info = merge_direction([
        {"frame": 1, "velocity": a, "sigma": sig},
        {"frame": 2, "velocity": b, "sigma": sig},
    ])
    assert info[1]["offset_m_yr"] == pytest.approx(0.003, abs=1e-6)
    assert np.allclose(merged, truth, atol=1e-9)
    overlap = (x >= 20) & (x < 40)
    assert np.allclose(sigma[overlap], 0.001 / np.sqrt(2))


def test_target_grid_covers_area():
    g = target_grid("POLYGON((-95.39 29.75,-95.37 29.75,-95.37 29.77,-95.39 29.77,-95.39 29.75))", "EPSG:32615")
    assert g.rio.crs.to_epsg() == 32615
    assert g.rio.resolution() == (30.0, -30.0)
    assert 60 <= g.shape[1] <= 80 and 70 <= g.shape[0] <= 90


def test_merge_direction_reports_empty_frame():
    good = np.full((10, 10), 0.01)
    empty = np.full((10, 10), np.nan)
    merged, sigma, info = merge_direction([
        {"frame": 2, "velocity": empty, "sigma": empty},
        {"frame": 1, "velocity": good, "sigma": np.full((10, 10), 0.002)},
    ])
    assert info[0] == {"frame": 1, "offset_m_yr": 0.0, "overlap_pixels": None, "role": "reference"}
    assert info[1]["role"] == "no valid pixels in area"
    np.testing.assert_allclose(merged, 0.01)
    np.testing.assert_allclose(sigma, 0.002)

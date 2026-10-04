"""GeoZarr writer + COG export on a synthetic stack (needs GDAL: run with jobs-env).

    jobs-env/bin/python -m pytest tests/test_geozarr_export.py
"""

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("osgeo")
pytest.importorskip("geozarr_toolkit")

import rasterio
import xarray as xr
import zarr
from pyproj import CRS

from disp_portal.export import export_geotiffs
from disp_portal.geozarr import velocity_fit, write_geozarr

RATE = -0.012  # m/yr


def _stack(tmp_path, ny=40, nx=30, nt=12):
    times = pd.date_range("2023-01-06", periods=nt, freq="12D")
    years = (times - times[0]).days.values / 365.25
    disp = RATE * years[:, None, None] * np.ones((nt, ny, nx), np.float32)
    disp[:, 0, 0] = np.nan  # a masked pixel
    x = 268920.0 + 15 + 30 * np.arange(nx)
    y = 3295680.0 - 15 - 30 * np.arange(ny)
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), disp, {"units": "meters"}),
            "average_temporal_coherence": (("y", "x"), np.full((ny, nx), 0.9, np.float32)),
            "spatial_ref": ((), 0, {"crs_wkt": CRS.from_epsg(32615).to_wkt(), "GeoTransform": "0 30 0 0 0 -30"}),
        },
        coords={"time": times, "y": y, "x": x},
    )
    path = tmp_path / "stack.zarr"
    ds.to_zarr(path, zarr_format=3, consolidated=False)
    return path


def test_velocity_fit_recovers_rate():
    da = xr.DataArray(
        RATE * (np.arange(10) * 12 / 365.25)[:, None, None] * np.ones((10, 2, 2)),
        dims=("time", "y", "x"),
        coords={"time": pd.date_range("2023-01-01", periods=10, freq="12D")},
    )
    slope, stderr, n = velocity_fit(da)
    assert np.allclose(stderr, 0, atol=1e-6)  # exact line: no scatter
    assert np.allclose(slope, RATE, atol=1e-4)
    assert (n == 10).all()


def test_geozarr_and_cog_export(tmp_path):
    stack = _stack(tmp_path)
    summary = write_geozarr(stack, tmp_path / "F08882_asc.zarr", min_size=8)
    assert summary["validation"] == "ok"
    assert summary["epsg"] == 32615 and len(summary["levels"]) >= 2
    attrs = dict(zarr.open_group(tmp_path / "F08882_asc.zarr" / "0", mode="r").attrs)
    # transform comes from the coordinates (the stack's GeoTransform attribute is wrong on purpose)
    assert attrs["spatial:transform"] == [30.0, 0.0, 268920.0, 0.0, -30.0, 3295680.0]

    recs = export_geotiffs(tmp_path / "F08882_asc.zarr", epochs=True)
    kinds = [r["kind"] for r in recs]
    assert kinds[:4] == ["velocity", "velocity_stderr", "coherence", "displacement_last"]
    assert kinds.count("displacement_epoch") == 12
    with rasterio.open(tmp_path / recs[0]["path"]) as src:
        assert src.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert src.crs.to_epsg() == 32615
        assert src.transform.c == 268920.0 and src.transform.f == 3295680.0
        v = src.read(1)
    # regression: the COG must carry the data (rio.to_raster(driver="COG") wrote zeros)
    assert np.isnan(v[0, 0])
    assert np.allclose(v[1:, 1:], RATE, atol=1e-4)


def test_lazy_coarsened_geozarr_matches_in_memory(tmp_path, monkeypatch):
    """Large-frame path: dask-backed fit + 3x coarsened level 0 (90 m), levels read back."""
    import disp_portal.geozarr as gz

    stack = _stack(tmp_path, ny=60, nx=48)
    eager = write_geozarr(stack, tmp_path / "eager.zarr", min_size=8)
    monkeypatch.setattr(gz, "IN_MEMORY_BYTES", 0)
    lazy = write_geozarr(stack, tmp_path / "lazy.zarr", min_size=8, coarsen=3, variables=("displacement",))
    assert lazy["validation"] == "ok"
    assert lazy["levels"][0]["y"] == 20 and lazy["levels"][0]["x"] == 16
    assert len(lazy["levels"]) == 2  # 20x16 -> 10x8, then stop (< 2 * min_size)
    assert lazy["velocity_median_m_yr"] == pytest.approx(eager["velocity_median_m_yr"], abs=1e-6)
    root = zarr.open_group(tmp_path / "lazy.zarr", mode="r")
    assert root.attrs["resolution_m"] == 90.0
    l0 = xr.open_zarr(tmp_path / "lazy.zarr", group="0", consolidated=False)
    assert "short_wavelength_displacement" not in l0
    assert float(l0["velocity"].load().median()) == pytest.approx(RATE, abs=1e-4)
    assert l0["displacement"].shape == (12, 20, 16)


def test_cube_timeseries_point_polygon_and_dedupe(tmp_path):
    import json

    import shapely
    from pyproj import Transformer

    from disp_portal.cubes import coverage, cube_timeseries

    stack = _stack(tmp_path)
    for job in ("20260101-000000-aaaaaa", "20260102-000000-bbbbbb"):  # same cube twice
        cube = tmp_path / "jobs" / job / "out" / "F08882_asc.zarr"
        cube.parent.mkdir(parents=True)
        write_geozarr(stack, cube, min_size=8, metadata={"corrections": {"solid_earth": True}})
        (tmp_path / "jobs" / job / "status.json").write_text(
            json.dumps({"frames": [{"frame": 8882, "direction": "asc", "state": "done", "cube": "out/F08882_asc.zarr"}]})
        )
    to_ll = Transformer.from_crs("EPSG:32615", "EPSG:4326", always_xy=True)
    lon, lat = to_ll.transform(268920.0 + 30 * 10.5, 3295680.0 - 30 * 5.5)  # centre of row 5, col 10

    series = cube_timeseries(tmp_path / "jobs", shapely.Point(lon, lat))
    assert len(series) == 1 and series[0]["job_id"] == "20260102-000000-bbbbbb"  # newest kept
    s = series[0]
    assert s["n_pixels"] == 1 and len(s["time"]) == 12
    assert s["displacement"][0] == 0.0
    assert abs(s["velocity"] - RATE) < 1e-4
    assert s["corrections"] == {"solid_earth": True}

    lon0, lat0 = to_ll.transform(268920.0 + 30 * 2, 3295680.0 - 30 * 10)
    lon1, lat1 = to_ll.transform(268920.0 + 30 * 6, 3295680.0 - 30 * 6)
    poly = shapely.box(lon0, lat0, lon1, lat1)
    s = cube_timeseries(tmp_path / "jobs", poly)[0]
    assert 10 <= s["n_pixels"] <= 20
    assert abs(s["displacement"][-1] - RATE * 11 * 12 / 365.25) < 1e-5

    assert cube_timeseries(tmp_path / "jobs", shapely.Point(10, 45)) == []
    assert cube_timeseries(tmp_path / "jobs", shapely.Point(lon, lat), ["desc"]) == []
    assert len(coverage(tmp_path / "jobs")["features"]) == 2


def test_cube_analyze_features(tmp_path):
    import json

    from pyproj import Transformer

    from disp_portal.cubes import analyze_features

    stack = _stack(tmp_path)
    cube = tmp_path / "jobs" / "j1" / "out" / "F08882_asc.zarr"
    cube.parent.mkdir(parents=True)
    write_geozarr(stack, cube, min_size=8)
    (tmp_path / "jobs" / "j1" / "status.json").write_text(
        json.dumps({"frames": [{"frame": 8882, "direction": "asc", "state": "done", "cube": "out/F08882_asc.zarr"}]})
    )
    to_ll = Transformer.from_crs("EPSG:32615", "EPSG:4326", always_xy=True)
    ll = lambda col, row: to_ll.transform(268920.0 + 30 * col, 3295680.0 - 30 * row)
    p = ll(10.5, 5.5)
    (x0, y0), (x1, y1) = ll(2, 10), ll(6, 6)
    features = [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": list(p)}},
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(ll(1.5, 3.5)), list(ll(20.5, 3.5))]}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [10, 45]}},
    ]
    res = analyze_features(tmp_path / "jobs", features, "asc", abs_threshold=0.01, step_m=30)
    assert abs(res[0]["median"] - RATE) < 1e-4 and res[0]["cube"]["frame"] == 8882
    assert res[0]["stderr_median"] is not None and res[0]["stderr_median"] < 1e-4
    assert 10 <= res[1]["n_pixels"] <= 20 and abs(res[1]["median"] - RATE) < 1e-4
    assert res[1]["fraction_abs_exceeding"] == 1.0 and "fraction_clipped" not in res[1]
    assert res[2]["geometry_type"] == "LineString" and res[2]["n_valid"] >= 15
    assert "no downloaded asc cube" in res[3]["error"]
    assert "no downloaded desc cube" in analyze_features(tmp_path / "jobs", features[:1], "desc")[0]["error"]


def test_reference_series_and_subtraction(tmp_path):
    """Epoch-by-epoch HIGH_COHERENCE reference, then subtracted when the cube is written."""
    from disp_portal.products import reference_series

    stack = _stack(tmp_path, ny=40, nx=30)
    ds = xr.open_zarr(stack, consolidated=False)
    offset = np.linspace(0, 0.02, ds.sizes["time"])  # common-mode signal per epoch
    shifted = ds.assign(displacement=ds["displacement"] + xr.DataArray(offset, dims="time"))
    ref = reference_series(shifted, threshold=0.7, stride=1)
    # every pixel shares the same series, so the median is the series itself
    expected = RATE * ((ds.time - ds.time[0]).dt.days.values / 365.25) + offset
    np.testing.assert_allclose(ref["values"], expected, atol=1e-6)
    assert ref["n_pixels"] == 40 * 30

    path = tmp_path / "shifted.zarr"
    shifted.to_zarr(path, zarr_format=3, consolidated=False)
    summary = write_geozarr(path, tmp_path / "ref.zarr", min_size=8, reference=ref["values"])
    l0 = xr.open_zarr(tmp_path / "ref.zarr", group="0", consolidated=False).load()
    assert float(np.nanmax(np.abs(l0["displacement"].values))) < 1e-5  # referenced to zero
    assert summary["validation"] == "ok"

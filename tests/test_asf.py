import json
from pathlib import Path

import pytest

from disp_portal.asf import normalize_direction, tile_url, timeseries_to_frame, to_wkt

DATA = Path(__file__).parent / "data"


def test_timeseries_to_frame_parses_fixture():
    raw = json.loads((DATA / "timeseries_point_F08882.json").read_text())
    df = timeseries_to_frame(raw, direction="ascending")
    assert "mean" not in set(df.granule)
    assert len(df) == len(raw) - 1
    assert set(df.frame_id) == {8882}
    assert df.secondary_datetime.is_monotonic_increasing
    assert df.reference_datetime.notna().all()
    assert df.attrs["mean"]["short_wavelength_displacement"] == pytest.approx(-0.0042072083)


def test_direction_and_urls():
    assert normalize_direction("ASC") == "ascending"
    assert normalize_direction("Descending") == "descending"
    with pytest.raises(ValueError):
        normalize_direction("north")
    assert tile_url("asc", "vel", 12, 1, 2).endswith("/main/asc/vel/12/1/2.png")
    assert to_wkt((-95.4, 29.75)) == "POINT(-95.4 29.75)"

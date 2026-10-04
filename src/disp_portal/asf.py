"""Client for the public assets behind the ASF Displacement Portal.

Three things are reused from https://displacement.asf.alaska.edu:

- the time-series API (``/frame_intersection``, ``/timeseries``), which allows any origin;
- the velocity / cumulative displacement overview tiles produced by
  ASFHyP3/OPERA-DISP-TMS, which only allow the ASF portal origin in a browser;
- the tile set's ``extent.json`` (bounds and the byte scaling range).

None of these endpoints are documented by ASF; the request shapes below were read
from the portal's frontend bundle.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Literal

import httpx
import pandas as pd
from shapely import wkt as shapely_wkt
from shapely.geometry.base import BaseGeometry

TIMESERIES_API = "https://d2qmcvu7qty7vn.cloudfront.net"
TILE_BASE = "https://d3g9emy65n853h.cloudfront.net/main"
OPERA_BUCKET = "asf-cumulus-prod-opera-products"

Direction = Literal["ascending", "descending"]
Kind = Literal["vel", "disp"]

_FRAME_RE = re.compile(r"_F(\d{5})_")
_DIR_SHORT = {"ascending": "asc", "descending": "desc"}


class AsfApiError(RuntimeError):
    """The ASF time-series service returned an error."""


class AsfNoDataError(AsfApiError):
    """No frame or no valid data at the requested geometry (not worth retrying)."""


# The service wraps "no data" in a 500, so match on the message as well as the status.
_NO_DATA_MARKERS = ("No valid data found", "No OPERA-S1 burst frame ids were found")


def normalize_direction(direction: str) -> Direction:
    d = direction.strip().lower()
    if d in ("asc", "ascending", "a"):
        return "ascending"
    if d in ("desc", "descending", "d"):
        return "descending"
    raise ValueError(f"Unknown flight direction: {direction!r}")


def to_wkt(geometry: BaseGeometry | str | tuple[float, float]) -> str:
    """Accept a shapely geometry, a WKT string, or a ``(lon, lat)`` pair."""
    if isinstance(geometry, str):
        return geometry
    if isinstance(geometry, tuple):
        lon, lat = geometry
        return f"POINT({lon} {lat})"
    return geometry.wkt


@dataclass
class AsfClient:
    """Thin synchronous client with retries, mirroring the ASF frontend (3 retries, 1 s)."""

    base_url: str = TIMESERIES_API
    timeout: float = 180.0
    retries: int = 3

    def _post(self, endpoint: str, payload: dict) -> dict:
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                response = httpx.post(
                    f"{self.base_url}{endpoint}", json=payload, timeout=self.timeout
                )
            except httpx.TransportError as e:
                last_error = e
            else:
                if response.status_code == 200:
                    return response.json()
                detail = _error_detail(response)
                if any(marker in detail for marker in _NO_DATA_MARKERS):
                    raise AsfNoDataError(f"{endpoint}: {detail}")
                if 400 <= response.status_code < 500:
                    raise AsfApiError(f"{endpoint} {response.status_code}: {detail}")
                last_error = AsfApiError(f"{endpoint} {response.status_code}: {detail}")
            if attempt < self.retries:
                time.sleep(1.0)
        raise AsfApiError(f"{endpoint} failed after {self.retries + 1} attempts: {last_error}")

    def frame_intersection(
        self, geometry: BaseGeometry | str | tuple[float, float], direction: str
    ) -> dict[int, BaseGeometry]:
        """Return ``{frame_id: geometry clipped to the frame}`` for frames covering ``geometry``."""
        payload = {
            "wkt": to_wkt(geometry),
            "flightDirection": normalize_direction(direction),
        }
        result = self._post("/frame_intersection", payload)
        return {int(fid): shapely_wkt.loads(g) for fid, g in result.items()}

    def timeseries(
        self, geometry: BaseGeometry | str | tuple[float, float], direction: str
    ) -> pd.DataFrame:
        """Fetch the short-wavelength displacement time series for a point or polygon.

        A polygon returns one aggregated value per epoch and no ``x``/``y`` columns.
        Where frames overlap the service returns a single frame of its own choosing
        (see ``frame_id``), which is not always the longest record.
        """
        payload = {
            "wkt": to_wkt(geometry),
            "bucket": OPERA_BUCKET,
            "polarization": "VV",
            "flightDirection": normalize_direction(direction).upper(),
        }
        result = self._post("/timeseries", payload)
        return timeseries_to_frame(result, direction=normalize_direction(direction))


def _error_detail(response: httpx.Response) -> str:
    try:
        return str(response.json().get("detail", response.text[:200]))
    except ValueError:
        return response.text[:200]


def timeseries_to_frame(result: dict, direction: str | None = None) -> pd.DataFrame:
    """Turn the ``/timeseries`` JSON (keyed by granule file name) into a tidy table.

    Besides one entry per granule the response carries a ``mean`` summary entry (no dates),
    which the ASF frontend skips; it is kept in ``df.attrs["mean"]``.
    """
    rows = []
    for granule, entry in result.items():
        if not granule.endswith(".nc") or not isinstance(entry, dict):
            continue
        match = _FRAME_RE.search(granule)
        rows.append(
            {
                "granule": granule,
                "frame_id": int(match.group(1)) if match else None,
                "reference_datetime": entry.get("reference_datetime"),
                "secondary_datetime": entry.get("secondary_datetime"),
                "temporal_baseline_days": entry.get("temporal_baseline"),
                "short_wavelength_displacement": entry.get("short_wavelength_displacement"),
                "x": entry.get("x"),
                "y": entry.get("y"),
                "netcdf_uri": entry.get("netcdf_uri"),
            }
        )
    df = pd.DataFrame(rows)
    df.attrs["mean"] = result.get("mean")
    if df.empty:
        return df
    for col in ("reference_datetime", "secondary_datetime"):
        df[col] = pd.to_datetime(df[col], errors="coerce")
    df["short_wavelength_displacement"] = pd.to_numeric(
        df["short_wavelength_displacement"], errors="coerce"
    )
    if direction is not None:
        df["direction"] = direction
    return df.sort_values("secondary_datetime").reset_index(drop=True)


def tile_url(direction: str, kind: Kind, z: int, x: int, y: int) -> str:
    d = _DIR_SHORT[normalize_direction(direction)]
    return f"{TILE_BASE}/{d}/{kind}/{z}/{x}/{y}.png"


def extent_url(direction: str, kind: Kind) -> str:
    d = _DIR_SHORT[normalize_direction(direction)]
    return f"{TILE_BASE}/{d}/{kind}/extent.json"


def fetch_extent(direction: str, kind: Kind = "vel", timeout: float = 30.0) -> dict:
    """``{"extent": [...EPSG:3857], "EPSG": 3857, "scale_range": {"range": [lo, hi], "units": ...}}``."""
    response = httpx.get(extent_url(direction, kind), timeout=timeout)
    response.raise_for_status()
    return response.json()

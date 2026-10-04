"""Phase 0 check: decoded ASF overview tiles vs velocity fitted to the ASF time series.

For each test point and direction:
  1. decode the zoom-12 overview tile pixel (m/yr);
  2. fetch the ASF ``/timeseries`` for the point and fit a least-squares slope to
     ``short_wavelength_displacement`` (epochs up to the tile set's date, since the
     tiles have not been regenerated since then);
  3. record timings and failures.

The overview used the minimum "spanning" set of granules, gap-filled NaNs and clipped
to +-3 cm/yr, so exact agreement is not expected; agreement to ~1-2 mm/yr where
|v| < 3 cm/yr confirms the decoding (sign, scale, offset, georeferencing).

Usage: python scripts/validate_decoder.py [--out results/phase0]
"""

from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from disp_portal.asf import AsfApiError, AsfClient
from disp_portal.tiles import TileFetcher, value_at

TILE_DATE = pd.Timestamp("2025-11-11")

POINTS = {
    "houston_downtown": (-95.370, 29.760),
    "houston_katy": (-95.800, 29.790),
    "houston_spring": (-95.420, 30.080),
    "las_vegas": (-115.150, 36.170),
    "denver": (-104.990, 39.740),
    "sacramento_delta": (-121.600, 38.100),
    "salt_lake_city": (-111.890, 40.760),
    "corcoran_ca": (-119.560, 36.100),
    "gulf_of_mexico": (-90.000, 25.000),
}


def fit_slope(df: pd.DataFrame, until: pd.Timestamp | None) -> tuple[float, int]:
    d = df.dropna(subset=["secondary_datetime", "short_wavelength_displacement"])
    if until is not None:
        d = d[d.secondary_datetime <= until]
    if len(d) < 2:
        return float("nan"), len(d)
    t = (d.secondary_datetime - d.secondary_datetime.min()).dt.days.to_numpy() / 365.25
    slope = np.polyfit(t, d.short_wavelength_displacement.to_numpy(), 1)[0]
    return float(slope), len(d)


def run_one(name: str, lon: float, lat: float, direction: str, fetcher: TileFetcher) -> dict:
    client = AsfClient(retries=1)
    row: dict = {"point": name, "lon": lon, "lat": lat, "direction": direction}

    t0 = time.perf_counter()
    row["tile_velocity"] = value_at(lon, lat, direction, "vel", fetcher=fetcher)
    row["t_tile_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    try:
        frames = client.frame_intersection((lon, lat), direction)
        row["frames"] = ",".join(str(f) for f in sorted(frames))
    except AsfApiError as e:
        row["frames"] = f"ERROR: {e}"
    row["t_frames_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    try:
        df = client.timeseries((lon, lat), direction)
    except AsfApiError as e:
        row["ts_error"] = str(e)[:200]
        row["t_ts_s"] = time.perf_counter() - t0
        return row
    row["t_ts_s"] = time.perf_counter() - t0
    row["n_epochs"] = len(df)
    row["ts_frames"] = ",".join(str(f) for f in sorted(df.frame_id.dropna().unique()))
    row["first_date"] = df.secondary_datetime.min()
    row["last_date"] = df.secondary_datetime.max()
    row["ts_velocity_to_tiledate"], row["n_fit"] = fit_slope(df, TILE_DATE)
    row["ts_velocity_all"], _ = fit_slope(df, None)
    row["diff_mm_yr"] = 1000 * (row["tile_velocity"] - row["ts_velocity_to_tiledate"])
    row["clipped"] = abs(row["tile_velocity"]) >= 0.0299 if np.isfinite(row["tile_velocity"]) else False
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path("results/phase0"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    fetcher = TileFetcher(cache_dir=Path(".cache/tiles"))
    jobs = [(n, lon, lat, d) for n, (lon, lat) in POINTS.items() for d in ("ascending", "descending")]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(lambda j: run_one(*j, fetcher=fetcher), jobs))

    df = pd.DataFrame(rows)
    df.to_csv(args.out / "decoder_validation.csv", index=False)

    cols = [
        "point", "direction", "frames", "n_epochs", "tile_velocity", "ts_velocity_to_tiledate",
        "diff_mm_yr", "clipped", "t_ts_s", "ts_error",
    ]
    cols = [c for c in cols if c in df]
    with pd.option_context("display.width", 200, "display.max_columns", 20, "display.float_format", "{:.4f}".format):
        print(df[cols].to_string(index=False))

    ok = df[df.get("diff_mm_yr").notna() & ~df.clipped.astype(bool)] if "diff_mm_yr" in df else df.iloc[0:0]
    if len(ok):
        print(
            f"\nunclipped comparisons: n={len(ok)}, median |diff|={ok.diff_mm_yr.abs().median():.2f} mm/yr, "
            f"max |diff|={ok.diff_mm_yr.abs().max():.2f} mm/yr"
        )
    print(f"time series response time: median {df.t_ts_s.median():.1f}s, max {df.t_ts_s.max():.1f}s")


if __name__ == "__main__":
    main()

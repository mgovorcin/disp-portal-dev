<!-- Internal development notes. -->
# Phase 0 notes: ASF portal assets (2026-10-03)

Measured with `scripts/validate_decoder.py` (results in `results/phase0/decoder_validation.csv`)
and `notebooks/00_asf_prototype.ipynb`.

## Tile decoder

- The tiles are PNG mode `LA` (gray + alpha), 256 px, zoom 2–12.
- `velocity = lo + (byte - 1) * (hi - lo) / 254`, with `(lo, hi)` from `extent.json` (`-0.03, 0.03` m/yr for `vel`). Alpha 0 means nodata.
- **Validation:** the decoded z12 pixel was compared with a least-squares slope fitted to the ASF `/timeseries` at the same point, using epochs up to 2025-11-11.
  - 13 unclipped point/direction pairs (Houston ×3, Las Vegas, Denver, Salt Lake City, Corcoran), both directions.
  - Median |diff| 0.51 mm/yr, max 1.55 mm/yr.
  - Remaining differences are expected: the tiles use a "spanning" subset of granules and fill gaps with 0.
- **Polygon check:** a ~4 km box near Katy. The ASF polygon time-series slope is -3.19 mm/yr; the decoded tile pixels inside it have mean -2.66 and median -2.60 mm/yr (n = 15 048).
- **Tile dates:** every tile checked has `last-modified` 2025-11-11. The time series runs to 2026-04, so the overview lags the time-series data by about 5 months.
- **Coverage gaps:** some pixels with a valid time series are NaN in the tiles (e.g. Houston Katy descending). This is the overview's rule that a pixel NaN in more than 10 % of epochs gets no velocity.

## Time-series API

| Behaviour | Detail | Consequence for the plugin |
|---|---|---|
| Response contents | one entry per granule plus a `mean` summary entry (no dates; mean displacement and mean temporal baseline) | skip `mean` (ASF does too); can show it as a summary |
| Point response | 74–449 epochs, depending on frame | |
| Polygon response | one aggregated value per epoch, no x/y | label it "polygon mean" |
| Response time | median 13.5 s, max 28.6 s (point); `/frame_intersection` about 0.6 s | spinner, cancel, cache; call `frame_intersection` first for quick feedback |
| Overlapping frames | the service picks **one** frame, with no consistent rule (lower ID at Las Vegas asc, higher at Denver asc). Salt Lake City asc got frame 5131, which ends in 2021-06, while other frames cover the point | show the frame ID; offer per-frame queries in Phase 2 (our own service) |
| No frame | HTTP 400, `No OPERA-S1 burst frame ids were found over the given aoi` | show "no coverage" |
| Frame but no valid data | HTTP **500** wrapping `400: No valid data found for wkt` (about 18 s) | treat as no data, do not retry (`AsfNoDataError`) |
| Re-referencing | `reference_datetime` is the first reference for all epochs, so ministacks are already stitched on the server | plot as is |

My earlier report of "null reference dates" was wrong: those nulls came from the `mean` entry.

## Product caveats to show in the UI

- **Short-wavelength only.** At Corcoran (Central Valley, a known subsidence area) the overview shows **+17.5 mm/yr asc and +14.9 mm/yr desc**. This is consistent with broad subsidence being filtered out by the short-wavelength product. Check it against full `displacement` in Phase 2 before stating it in the UI.
- **Precision:** quantized to 0.24 mm/yr, clipped to ±3 cm/yr, about 33 m pixels at z12 (30° N).
- **CORS:** ASF tiles allow only `https://displacement.asf.alaska.edu`. In the notebook the decoded tiles are added to GeoLibre as in-memory rasters. The plugin needs the Phase 1 proxy.

## Plan changes from Phase 0

- Phase 1c: handle the `mean` entry and the no-data 500. Show the frame chosen by the service, and its date range.
- Phase 1b: show the tile date (2025-11-11) in the legend.
- Phase 2b: add a `frame` parameter to our own time-series API, so overlapping frames can be compared.

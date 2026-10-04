"""Our own velocity products (Phase 2): whole DISP-S1 frames, processed one at a time.

Runs in ``jobs-env``. Each frame is streamed through a scratch directory, so the disk only
ever holds a few raw stacks (a CONUS frame is ~76 GB of NetCDF; all of CONUS ~58 TB)::

    download (opera-utils run_download, whole frame)
      -> reformat_stack (re-referenced displacement, solid-earth tide applied)
      -> velocity fit at 30 m (dask, block by block)
      -> COGs at 30 m + GeoZarr cube at 90 m (+ 30 m cube with --full-res-cube)
      -> DISP-S1-STATIC line of sight
      -> delete the scratch directory

Layout under ``--root`` (default ``products/``)::

    catalog.json                    frames of the region with their CMR granule counts
    frames/F08882/frame.json        state + summary (state "done" = skipped on re-runs)
    frames/F08882/frame.log
    frames/F08882/F08882_asc_{velocity,velocity_stderr,valid_epochs,coherence}.tif
    frames/F08882/F08882_asc_90m.zarr     time-series cube (multiscale GeoZarr)
    frames/F08882/F08882_asc_30m.zarr     only with --full-res-cube
    frames/F08882/static/*_line_of_sight_enu.tif
    work/F08882/                    scratch (download/, stack.zarr, tmp/), removed after success

Commands::

    python -m disp_portal.products catalog [--region conus]
    python -m disp_portal.products frame 8882 [--full-res-cube]
    python -m disp_portal.products run --frames 8882 38238 ... | --region conus [--limit N]
                                       [--parallel 2] [--full-res-cube]
    python -m disp_portal.products status
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger("disp_portal.products")

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "products"
CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
COLLECTION = "OPERA_L3_DISP-S1_V1"
# Rough lon/lat boxes; frames with no products (ocean, Canada/Mexico outside coverage)
# drop out through their CMR granule count.
REGIONS = {
    "conus": (-125.0, 24.5, -66.9, 49.5),
    "houston": (-96.0, 29.2, -94.7, 30.3),
}
CUBE_COARSEN = 3  # 30 m -> 90 m
# Quality layers reformat_stack would otherwise copy for every epoch (several hundred GB per
# frame). Kept: temporal_coherence (average coherence), recommended_mask (re-referencing mask),
# water_mask.
DROP_QUALITY = (
    "phase_similarity",
    "persistent_scatterer_mask",
    "timeseries_inversion_residuals",
    "connected_component_labels",
    "estimated_phase_quality",
    "shp_counts",
)
DASK_THREADS = int(os.environ.get("DISP_PRODUCTS_DASK_THREADS", "8"))  # shared machine


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str))
    tmp.replace(path)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def frame_name(frame: int) -> str:
    return f"F{frame:05d}"


# ── catalogue ──
def _granule_count(frame: int) -> int:
    import httpx

    params = {"short_name": COLLECTION, "attribute[]": f"int,FRAME_NUMBER,{frame}", "page_size": 0}
    for attempt in range(3):
        try:
            r = httpx.get(CMR_URL, params=params, timeout=60)
            r.raise_for_status()
            return int(r.headers.get("CMR-Hits", 0))
        except Exception:  # noqa: BLE001 - retried, then reported as unknown
            time.sleep(2 * (attempt + 1))
    return -1


def build_catalog(root: Path, region: str = "conus", workers: int = 8) -> dict:
    """Frames of `region` (North-America land frames in its box) with CMR granule counts."""
    from opera_utils.burst_frame_db import get_frame_geodataframe
    from shapely.geometry import box

    gdf = get_frame_geodataframe()
    sel = gdf[gdf.is_north_america & (gdf.is_land == 1) & gdf.intersects(box(*REGIONS[region]))]
    frames = [int(f) for f in sel.index]
    with ThreadPoolExecutor(workers) as ex:
        counts = list(ex.map(_granule_count, frames))
    rows = [
        {
            "frame": f,
            "direction": "asc" if sel.loc[f, "orbit_pass"] == "ASCENDING" else "desc",
            "granules": n,
            "bbox": [round(v, 4) for v in sel.loc[f, "geometry"].bounds],
        }
        for f, n in zip(frames, counts, strict=True)
    ]
    catalog = {
        "region": region,
        "bbox": REGIONS[region],
        "created": _now(),
        "n_frames": len(rows),
        "n_with_products": sum(r["granules"] > 0 for r in rows),
        "frames": rows,
    }
    root.mkdir(parents=True, exist_ok=True)
    _write_json(root / f"catalog_{region}.json", catalog)
    return catalog


def frame_direction(frame: int) -> str:
    from opera_utils.burst_frame_db import get_frame_orbit_pass

    return "asc" if str(get_frame_orbit_pass(frame)[0]).upper().startswith("ASC") else "desc"


# ── download ──
def _granule_ok(path: Path) -> bool:
    import h5py

    try:
        with h5py.File(path, "r") as f:
            return "displacement" in f
    except Exception:  # noqa: BLE001 - any read failure means re-download
        return False


def download_frame(frame: int, out_dir: Path, workers: int = 16, chunk_mb: int = 8) -> list[Path]:
    """Download every (de-duplicated, v1.0) granule of a whole frame, streaming to disk.

    opera-utils' ``run_download`` holds each file in memory and re-encodes it through its
    subset step (~4 GB per worker); a whole frame needs neither. Files are written as
    ``.part`` and renamed when complete, so an interrupted run resumes safely.
    """
    import requests
    from opera_utils.credentials import get_earthdata_username_password
    from opera_utils.disp import search
    from opera_utils.disp._product import DispProductStack

    stack = DispProductStack(search(frame_id=frame, product_version="1.0"))
    urls = [str(u) for u in stack.filenames]
    out_dir.mkdir(parents=True, exist_ok=True)
    auth = get_earthdata_username_password()
    log.info("%s: %d granules", frame_name(frame), len(urls))

    def fetch(url: str) -> Path:
        dest = out_dir / url.rsplit("/", 1)[-1]
        if dest.exists() and _granule_ok(dest):
            return dest
        part = dest.with_suffix(dest.suffix + ".part")
        for attempt in range(4):
            try:
                with requests.Session() as session:
                    session.auth = auth
                    with session.get(url, stream=True, timeout=(30, 300)) as r:
                        r.raise_for_status()
                        with open(part, "wb") as f:
                            f.writelines(r.iter_content(chunk_mb * 2**20))
                part.replace(dest)
                return dest
            except Exception as e:  # noqa: BLE001 - retried with back-off
                log.warning("%s: attempt %d failed: %s", dest.name, attempt + 1, e)
                time.sleep(10 * (attempt + 1))
        raise RuntimeError(f"could not download {url}")

    with ThreadPoolExecutor(workers) as ex:
        return sorted(ex.map(fetch, urls))


# ── spatial reference ──
REFERENCE_COHERENCE = 0.7  # as reformat_stack's HIGH_COHERENCE default


def reference_series(ds, threshold: float = REFERENCE_COHERENCE, stride: int = 2) -> dict:
    """Per-epoch median displacement of high-coherence pixels (reformat_stack HIGH_COHERENCE),
    read one time chunk at a time; every `stride`-th pixel in y and x is enough for a median."""
    import numpy as np

    coh = np.asarray(ds["average_temporal_coherence"].values)[::stride, ::stride]
    good = coh > threshold
    if not good.any():
        raise RuntimeError(f"no pixel with average temporal coherence > {threshold}")
    disp = ds["displacement"]
    step_t = disp.chunks[0][0] if disp.chunks else 1
    values = np.full(disp.sizes["time"], np.nan)
    for t0 in range(0, disp.sizes["time"], step_t):
        block = np.asarray(disp[t0 : t0 + step_t, ::stride, ::stride].values)
        values[t0 : t0 + step_t] = [np.nanmedian(b[good]) for b in block]
    return {"values": values, "n_pixels": int(good.sum()) * stride * stride}


# ── one frame ──
def process_frame(frame: int, root: Path, *, full_res_cube: bool = False, download_workers: int = 16,
                  keep_work: bool = False) -> dict:
    """Download, fit and write the products of one whole frame. Returns its frame.json."""
    import dask

    from disp_portal.export import _with_geo, _write
    from disp_portal.geozarr import velocity_fit, write_geozarr

    name = frame_name(frame)
    out = root / "frames" / name
    work = root / "work" / name
    out.mkdir(parents=True, exist_ok=True)
    (work / "tmp").mkdir(parents=True, exist_ok=True)
    # opera-utils stages each HTTPS download in a NamedTemporaryFile: keep it off /tmp.
    os.environ["TMPDIR"] = str(work / "tmp")
    tempfile.tempdir = str(work / "tmp")

    state_path = out / "frame.json"
    direction = frame_direction(frame)
    state: dict = {"frame": frame, "direction": direction, "state": "running", "started": _now(), "steps": {}}
    _write_json(state_path, state)
    t_frame = time.time()

    def step(label: str, fn):
        state["step"] = label
        _write_json(state_path, state)
        t = time.time()
        log.info("%s: %s", name, label)
        result = fn()
        state["steps"][label] = round(time.time() - t, 1)
        _write_json(state_path, state)
        return result

    try:
        from opera_utils.disp._enums import ReferenceMethod
        from opera_utils.disp._reformat import reformat_stack

        files = step(
            "download",
            lambda: download_frame(frame, work / "download", workers=download_workers),
        )
        if not files:
            state.update(state="no data", finished=_now())
            _write_json(state_path, state)
            return state
        state["n_granules"] = len(files)
        state["download_bytes"] = sum(f.stat().st_size for f in files)

        stack = work / "stack.zarr"
        with dask.config.set(scheduler="threads", num_workers=DASK_THREADS):
            done_marker = work / "stack.done"  # a killed reformat leaves a partial stack.zarr
            if not done_marker.exists():
                shutil.rmtree(stack, ignore_errors=True)
                step(
                    "reformat",
                    # Spatial referencing is done below, epoch by epoch: reformat_stack's
                    # HIGH_COHERENCE median makes every chunk depend on the whole frame
                    # (~80 GB in memory, single-threaded).
                    lambda: reformat_stack(
                        files,
                        str(stack),
                        apply_solid_earth_corrections=True,
                        drop_vars=list(DROP_QUALITY),
                        reference_method=ReferenceMethod.NONE,
                    ),
                )
                done_marker.touch()
            if not keep_work:
                shutil.rmtree(work / "download", ignore_errors=True)

            import xarray as xr

            from disp_portal.geozarr import _crs_of, _transform_from_coords

            ds = xr.open_zarr(stack, consolidated=False)
            crs = _crs_of(ds)
            crs_code = f"EPSG:{crs.to_epsg()}"
            reference = step("reference", lambda: reference_series(ds))
            state["reference"] = {
                "method": f"median of pixels with average temporal coherence > {REFERENCE_COHERENCE}",
                "n_pixels": reference["n_pixels"],
                "values_m": [round(float(v), 5) for v in reference["values"]],
            }
            ref = xr.DataArray(reference["values"], dims="time", coords={"time": ds.time})
            fit = step("velocity fit", lambda: velocity_fit(ds["displacement"] - ref))
            vel, vel_std, n_valid = fit

            def cogs() -> list[dict]:
                transform = _transform_from_coords(ds.x.values, ds.y.values)
                template = xr.DataArray(dims=("y", "x"), coords={"y": ds.y, "x": ds.x}, data=vel)
                layers = [
                    ("velocity", vel, "m/yr", "LOS velocity (least-squares slope of re-referenced displacement)"),
                    ("velocity_stderr", vel_std, "m/yr", "formal 1-sigma of the velocity (white noise)"),
                    ("valid_epochs", n_valid, "count", "epochs with valid displacement"),
                ]
                if "average_temporal_coherence" in ds:
                    layers.append(("coherence", ds["average_temporal_coherence"].values, "1",
                                   "average temporal coherence"))
                recs = []
                for kind, arr, units, desc in layers:
                    da = _with_geo(template.copy(data=arr.astype("float32")), crs_code, transform)
                    rec = _write(da, out / f"{name}_{direction}_{kind}.tif", units, desc)
                    recs.append({**rec, "kind": kind})
                return recs

            state["geotiffs"] = step("COGs", cogs)
            meta = {"frame_id": frame, "direction": direction, "corrections": {"solid_earth": True, "ionosphere": False},
                    "product": "disp-portal velocity products"}
            state["cube_90m"] = step(
                "cube 90 m",
                lambda: write_geozarr(stack, out / f"{name}_{direction}_90m.zarr", coarsen=CUBE_COARSEN, fit=fit,
                                      reference=reference["values"], metadata=meta),
            )
            if full_res_cube:
                state["cube_30m"] = step(
                    "cube 30 m",
                    lambda: write_geozarr(stack, out / f"{name}_{direction}_30m.zarr", fit=fit,
                                          reference=reference["values"], metadata=meta),
                )

        def static() -> dict:
            from opera_utils.disp._static import download_static

            try:
                written = download_static(frame, output_dir=out / "static", layers=("line_of_sight_enu",))
                return {k: str(v.relative_to(out)) for k, v in written.items()}
            except Exception as e:  # noqa: BLE001 - products stay usable without it
                log.warning("%s: static layers not available: %s", name, e)
                return {"error": str(e)[:300]}

        state["static"] = step("static", static)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        state["output_bytes"] = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
        state.update(state="done", step="finished", finished=_now(), elapsed_s=round(time.time() - t_frame, 1))
        import resource

        state["peak_rss_gb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1)
    except Exception as e:  # noqa: BLE001 - recorded for the runner and status
        log.error("%s failed: %s\n%s", name, e, traceback.format_exc())
        state.update(state="failed", error=str(e)[:500], finished=_now(), elapsed_s=round(time.time() - t_frame, 1))
    _write_json(state_path, state)
    return state


# ── many frames ──
def run_frames(frames: list[int], root: Path, *, parallel: int = 2, full_res_cube: bool = False,
               download_workers: int = 16, retry_failed: bool = True) -> None:
    """Process frames, `parallel` at a time, each in its own process (memory is returned
    after every frame). Frames already "done" are skipped, so a stopped run resumes."""
    todo = []
    for f in frames:
        st = _read_json(root / "frames" / frame_name(f) / "frame.json") or {}
        if st.get("state") in ("done", "no data") or (st.get("state") == "failed" and not retry_failed):
            continue
        todo.append(f)
    log.info("%d of %d frames to process (%d at a time)", len(todo), len(frames), parallel)

    def one(frame: int) -> int:
        out = root / "frames" / frame_name(frame)
        out.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, "-m", "disp_portal.products", "--root", str(root), "frame", str(frame),
               "--download-workers", str(download_workers)] + (["--full-res-cube"] if full_res_cube else [])
        with open(out / "frame.log", "a") as logf:
            code = subprocess.call(cmd, stdout=logf, stderr=subprocess.STDOUT)
        st = _read_json(out / "frame.json") or {}
        log.info("%s: %s (%s s)", frame_name(frame), st.get("state", f"exit {code}"), st.get("elapsed_s"))
        return code

    with ThreadPoolExecutor(parallel) as ex:
        list(ex.map(one, todo))


def status(root: Path) -> dict:
    rows = [_read_json(p) or {} for p in sorted((root / "frames").glob("F*/frame.json"))]
    by_state: dict[str, int] = {}
    for r in rows:
        by_state[r.get("state", "?")] = by_state.get(r.get("state", "?"), 0) + 1
    done = [r for r in rows if r.get("state") == "done"]
    return {
        "frames": len(rows),
        "by_state": by_state,
        "output_gb": round(sum(r.get("output_bytes", 0) for r in done) / 1e9, 1),
        "download_gb": round(sum(r.get("download_bytes", 0) for r in done) / 1e9, 1),
        "mean_frame_s": round(sum(r.get("elapsed_s", 0) for r in done) / len(done), 1) if done else None,
        "running": [{"frame": r["frame"], "step": r.get("step")} for r in rows if r.get("state") == "running"],
        "failed": [{"frame": r["frame"], "error": r.get("error")} for r in rows if r.get("state") == "failed"],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m disp_portal.products", description=__doc__.split("\n")[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("catalog", help="list a region's frames with CMR granule counts")
    c.add_argument("--region", choices=sorted(REGIONS), default="conus")
    f = sub.add_parser("frame", help="process one frame (in this process)")
    f.add_argument("frame", type=int)
    f.add_argument("--full-res-cube", action="store_true")
    f.add_argument("--download-workers", type=int, default=16)
    f.add_argument("--keep-work", action="store_true")
    r = sub.add_parser("run", help="process many frames, resumable")
    r.add_argument("--frames", type=int, nargs="*")
    r.add_argument("--region", choices=sorted(REGIONS))
    r.add_argument("--limit", type=int)
    r.add_argument("--parallel", type=int, default=2)
    r.add_argument("--full-res-cube", action="store_true")
    r.add_argument("--download-workers", type=int, default=16)
    sub.add_parser("status", help="summary of processed frames")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True)

    if args.cmd == "catalog":
        cat = build_catalog(args.root, args.region)
        print(json.dumps({k: v for k, v in cat.items() if k != "frames"}, indent=1))
    elif args.cmd == "frame":
        st = process_frame(args.frame, args.root, full_res_cube=args.full_res_cube,
                           download_workers=args.download_workers, keep_work=args.keep_work)
        raise SystemExit(0 if st["state"] in ("done", "no data") else 1)
    elif args.cmd == "run":
        frames = list(args.frames or [])
        if args.region:
            cat = _read_json(args.root / f"catalog_{args.region}.json") or build_catalog(args.root, args.region)
            frames += [row["frame"] for row in cat["frames"] if row["granules"] > 0]
        if args.limit:
            frames = frames[: args.limit]
        if not frames:
            parser.error("give --frames or --region")
        run_frames(frames, args.root, parallel=args.parallel, full_res_cube=args.full_res_cube,
                   download_workers=args.download_workers)
        print(json.dumps(status(args.root), indent=1))
    else:
        print(json.dumps(status(args.root), indent=1))


if __name__ == "__main__":
    main()

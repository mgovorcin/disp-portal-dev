"""Download a DISP-S1 subset with opera-utils and prepare it as GeoZarr cubes.

Runs in ``jobs-env`` (conda-forge GDAL + the local opera-utils), launched by disp-proxy::

    jobs-env/bin/python -m disp_portal.prepare jobs/<id>/job.json

Job directory layout::

    job.json        the request (area WKT, dates, directions, options)
    status.json     state / step / progress / per-frame results (read by the proxy)
    job.log         log
    download/Fxxxxx/*.nc      subset NetCDFs from opera_utils run_download
    stack/Fxxxxx.zarr         reformat_stack output (removed after success unless keep_stack)
    out/Fxxxxx_<dir>.zarr     GeoZarr cube (disp_portal.geozarr)
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from shapely import wkt as shapely_wkt

log = logging.getLogger("disp_portal.prepare")


@dataclass
class JobSpec:
    id: str
    wkt: str
    start: str | None = None  # YYYY-MM-DD
    end: str | None = None
    directions: list[str] = field(default_factory=lambda: ["asc", "desc"])
    frames: list[int] | None = None  # override frame discovery
    apply_solid_earth: bool = True
    apply_ionosphere: bool = False
    num_workers: int = 4
    product_version: str | None = "1.0"
    keep_stack: bool = False
    geotiff: bool = False
    geotiff_epochs: bool = False
    # DISP-S1-STATIC line-of-sight layers + frame merge + asc/desc decomposition
    combine: bool = True
    title: str = ""

    @classmethod
    def load(cls, path: Path) -> JobSpec:
        data = json.loads(path.read_text())
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Status:
    """status.json writer; written atomically so the proxy never reads a partial file."""

    def __init__(self, path: Path, spec: JobSpec):
        self.path = path
        self.data: dict = {
            "id": spec.id,
            "state": "running",
            "step": "starting",
            "progress": 0.0,
            "pid": os.getpid(),
            "started": _now(),
            "finished": None,
            "error": None,
            "frames": [],
        }
        self.write()

    def write(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1, default=str))
        tmp.replace(self.path)

    def update(self, **kw) -> None:
        self.data.update(kw)
        self.write()


def discover_frames(spec: JobSpec) -> list[tuple[int, str]]:
    """(frame_id, direction) pairs covering the area, from the ASF frame service."""
    if spec.frames:
        return [(int(f), d) for d in spec.directions for f in spec.frames]
    from disp_portal.asf import AsfClient, AsfNoDataError

    client = AsfClient(retries=2)
    pairs: list[tuple[int, str]] = []
    for direction in spec.directions:
        try:
            frames = client.frame_intersection(spec.wkt, direction)
        except AsfNoDataError:
            log.info("no %s frames over the area", direction)
            continue
        pairs.extend((fid, direction) for fid in sorted(frames))
    return pairs


def _parse_day(value: str | None) -> datetime | None:
    # opera-utils' CMR search takes naive UTC datetimes.
    return datetime.strptime(value, "%Y-%m-%d") if value else None  # noqa: DTZ007


def run(job_json: Path) -> int:
    job_dir = job_json.parent
    spec = JobSpec.load(job_json)
    status = Status(job_dir / "status.json", spec)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(job_dir / "job.log"), logging.StreamHandler(sys.stdout)],
        force=True,
    )
    t0 = time.time()
    try:
        area = shapely_wkt.loads(spec.wkt)
        log.info("job %s: area %s, %s .. %s, directions %s", spec.id, area.bounds, spec.start, spec.end, spec.directions)
        status.update(step="finding frames")
        pairs = discover_frames(spec)
        if not pairs:
            raise RuntimeError("No OPERA DISP-S1 frame covers this area.")
        status.update(frames=[{"frame": f, "direction": d, "state": "queued"} for f, d in pairs])
        log.info("frames: %s", pairs)

        from opera_utils.disp._download import run_download
        from opera_utils.disp._reformat import reformat_stack

        from disp_portal.geozarr import write_geozarr

        n = len(pairs)
        for i, (frame, direction) in enumerate(pairs):
            entry = status.data["frames"][i]
            name = f"F{frame:05d}"

            def mark(step: str, frac: float, entry=entry, label=f"{name} {direction}", i=i) -> None:
                entry["state"] = step
                status.update(step=f"{label}: {step}", progress=round((i + frac) / n, 3))

            mark("downloading", 0.0)
            files = run_download(
                frame_id=frame,
                start_datetime=_parse_day(spec.start),
                end_datetime=_parse_day(spec.end),
                wkt=spec.wkt,
                num_workers=spec.num_workers,
                product_version=spec.product_version,
                output_dir=job_dir / "download" / name,
            )
            files = sorted(files)
            entry["n_files"] = len(files)
            if not files:
                entry["state"] = "no data"
                status.write()
                continue

            mark("re-referencing", 0.6)
            stack = job_dir / "stack" / f"{name}.zarr"
            stack.parent.mkdir(parents=True, exist_ok=True)
            reformat_stack(
                files,
                str(stack),
                apply_solid_earth_corrections=spec.apply_solid_earth,
                apply_ionospheric_corrections=spec.apply_ionosphere,
            )

            mark("writing GeoZarr", 0.85)
            cube = job_dir / "out" / f"{name}_{direction}.zarr"
            cube.parent.mkdir(parents=True, exist_ok=True)
            summary = write_geozarr(
                stack,
                cube,
                metadata={
                    "frame_id": frame,
                    "direction": direction,
                    "area_wkt": spec.wkt,
                    "job_id": spec.id,
                    "corrections": {"solid_earth": spec.apply_solid_earth, "ionosphere": spec.apply_ionosphere},
                },
            )
            if not spec.keep_stack:
                shutil.rmtree(stack, ignore_errors=True)
            geotiffs: list[dict] = []
            if spec.geotiff or spec.geotiff_epochs:
                mark("writing GeoTIFFs", 0.95)
                from disp_portal.export import export_geotiffs

                for rec in export_geotiffs(cube, epochs=spec.geotiff_epochs):
                    geotiffs.append({**rec, "path": f"{cube.parent.relative_to(job_dir)}/{rec['path']}"})
            static: dict[str, str] = {}
            if spec.combine:
                mark("downloading static layers", 0.97)
                try:
                    from opera_utils.disp._static import download_static

                    written = download_static(
                        frame, wkt=spec.wkt, output_dir=job_dir / "static" / name, layers=("line_of_sight_enu",)
                    )
                    static = {k: str(v.relative_to(job_dir)) for k, v in written.items()}
                except Exception as e:  # noqa: BLE001 - the cube is still useful without it
                    log.warning("%s: static layers not available: %s", name, e)
            entry.update(
                state="done", cube=str(cube.relative_to(job_dir)), summary=summary, geotiffs=geotiffs, static=static
            )
            status.update(progress=round((i + 1) / n, 3))
            log.info("%s %s done: %s", name, direction, summary)

        done = [f for f in status.data["frames"] if f["state"] == "done"]
        if done and spec.combine:
            status.update(step="merging frames and decomposing asc/desc", progress=0.99)
            try:
                from disp_portal.combine import combine_job

                status.update(combined=combine_job(job_dir, spec.wkt, status.data["frames"]))
            except Exception as e:  # noqa: BLE001 - per-frame results stay valid
                log.error("combine failed: %s\n%s", e, traceback.format_exc())
                status.update(combined={"error": str(e)[:300]})
        status.update(
            state="done" if done else "failed",
            step="finished" if done else "no data for any frame",
            progress=1.0,
            finished=_now(),
            error=None if done else "No epochs found for the area and dates.",
            elapsed_s=round(time.time() - t0, 1),
        )
        return 0 if done else 1
    except Exception as e:  # noqa: BLE001 - every failure must reach status.json for the UI
        log.error("job failed: %s\n%s", e, traceback.format_exc())
        status.update(state="failed", error=str(e)[:500], finished=_now(), elapsed_s=round(time.time() - t0, 1))
        return 1


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python -m disp_portal.prepare <job.json>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(run(Path(sys.argv[1]).resolve()))


if __name__ == "__main__":
    main()

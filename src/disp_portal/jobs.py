"""Job manager for "download a DISP-S1 subset and prepare GeoZarr" (runs inside disp-proxy).

Each job is a directory under ``JOBS_DIR`` with ``job.json`` (request) and ``status.json``
(written by the runner, :mod:`disp_portal.prepare`, which runs in ``jobs-env`` because it
needs GDAL and the local opera-utils). Runners are separate process groups, so they keep
going if the proxy restarts; their pid is in ``status.json`` for cancelling.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import uuid
from datetime import UTC, date, datetime
from pathlib import Path

from pydantic import BaseModel, Field, field_validator, model_validator
from pyproj import Geod
from shapely.geometry import box, mapping, shape
from shapely.geometry.base import BaseGeometry

PORTAL = Path(__file__).resolve().parents[2]
JOBS_DIR = Path(os.environ.get("DISP_JOBS_DIR", PORTAL / "jobs"))
JOBS_PYTHON = Path(os.environ.get("DISP_JOBS_PYTHON", PORTAL / "jobs-env" / "bin" / "python"))
MAX_CONCURRENT = int(os.environ.get("DISP_JOBS_MAX_CONCURRENT", "2"))
MAX_AREA_KM2 = float(os.environ.get("DISP_JOBS_MAX_AREA_KM2", "2500"))
TERMINAL = {"done", "failed", "cancelled"}
MAX_AGE_DAYS = float(os.environ.get("DISP_JOBS_MAX_AGE_DAYS", "30"))
MAX_TOTAL_GB = float(os.environ.get("DISP_JOBS_MAX_TOTAL_GB", "20"))
CLEANUP_EVERY_TICKS = 120  # tick runs every 5 s in the proxy -> every 10 min

_geod = Geod(ellps="WGS84")


def area_km2(geom: BaseGeometry) -> float:
    return abs(_geod.geometry_area_perimeter(geom)[0]) / 1e6


class JobRequest(BaseModel):
    """What the plugin sends. Either `geometry` (GeoJSON Polygon/MultiPolygon) or `bbox`."""

    geometry: dict | None = None
    bbox: tuple[float, float, float, float] | None = None
    start: date | None = None
    end: date | None = None
    directions: list[str] = Field(default_factory=lambda: ["asc", "desc"])
    apply_solid_earth: bool = True
    apply_ionosphere: bool = False
    geotiff: bool = False
    geotiff_epochs: bool = False
    combine: bool = True
    title: str = Field("", max_length=80)

    @field_validator("directions")
    @classmethod
    def _dirs(cls, v: list[str]) -> list[str]:
        out = set()
        for d in v:
            d = d.strip().lower()
            if d.startswith("a"):
                out.add("asc")
            elif d.startswith("d"):
                out.add("desc")
            else:
                raise ValueError("directions must be 'asc' and/or 'desc'")
        if not out:
            raise ValueError("give at least one direction")
        return sorted(out)

    @model_validator(mode="after")
    def _area(self) -> JobRequest:
        if (self.geometry is None) == (self.bbox is None):
            raise ValueError("give exactly one of geometry or bbox")
        if self.start and self.end and self.start > self.end:
            raise ValueError("start must be before end")
        return self

    def area(self) -> BaseGeometry:
        geom = box(*self.bbox) if self.bbox else shape(self.geometry)
        if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.is_empty:
            raise ValueError("area must be a polygon")
        if not geom.is_valid:
            geom = geom.buffer(0)
        km2 = area_km2(geom)
        if km2 > MAX_AREA_KM2:
            raise ValueError(f"area is {km2:,.0f} km², limit is {MAX_AREA_KM2:,.0f} km²")
        return geom


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A finished child stays a zombie until reaped; treat it as not running.
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        return waited == 0
    except ChildProcessError:
        return True


class JobManager:
    def __init__(
        self,
        root: Path = JOBS_DIR,
        python: Path = JOBS_PYTHON,
        max_concurrent: int = MAX_CONCURRENT,
        max_age_days: float = MAX_AGE_DAYS,
        max_total_gb: float = MAX_TOTAL_GB,
    ):
        self.root = root
        self.python = python
        self.max_concurrent = max_concurrent
        self.max_age_days = max_age_days
        self.max_total_gb = max_total_gb
        self._ticks = 0
        self.root.mkdir(parents=True, exist_ok=True)

    # ── paths and records ──
    def _dir(self, job_id: str) -> Path:
        if not job_id or "/" in job_id or job_id.startswith("."):
            raise KeyError(job_id)
        path = self.root / job_id
        if not (path / "job.json").is_file():
            raise KeyError(job_id)
        return path

    def _write_status(self, job_dir: Path, **kw) -> dict:
        status = _read_json(job_dir / "status.json") or {}
        status.update(kw)
        tmp = job_dir / "status.tmp"
        tmp.write_text(json.dumps(status, indent=1))
        tmp.replace(job_dir / "status.json")
        return status

    def record(self, job_id: str, log_lines: int = 0) -> dict:
        job_dir = self._dir(job_id)
        status = _read_json(job_dir / "status.json") or {"state": "unknown"}
        if status.get("state") == "running" and not _pid_alive(status.get("pid")):
            status = self._write_status(job_dir, state="failed", error="runner stopped unexpectedly")
        rec = {"id": job_id, "request": _read_json(job_dir / "job.json"), **status}
        if log_lines:
            log = job_dir / "job.log"
            rec["log"] = log.read_text(errors="replace").splitlines()[-log_lines:] if log.exists() else []
        return rec

    def list(self) -> list[dict]:
        """All jobs, newest first (by request creation time, else job.json mtime)."""
        out = [self.record(d.name) for d in self.root.iterdir() if (d / "job.json").is_file()]

        def created(rec: dict) -> str:
            stamp = (rec.get("request") or {}).get("created")
            if stamp:
                return stamp
            mtime = (self.root / rec["id"] / "job.json").stat().st_mtime
            return datetime.fromtimestamp(mtime, UTC).isoformat(timespec="seconds")

        return sorted(out, key=created, reverse=True)

    # ── lifecycle ──
    def create(self, req: JobRequest) -> dict:
        geom = req.area()
        job_id = f"{datetime.now(UTC):%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True)
        spec = {
            "id": job_id,
            "wkt": geom.wkt,
            "start": req.start.isoformat() if req.start else None,
            "end": req.end.isoformat() if req.end else None,
            "directions": req.directions,
            "apply_solid_earth": req.apply_solid_earth,
            "apply_ionosphere": req.apply_ionosphere,
            "geotiff": req.geotiff,
            "geotiff_epochs": req.geotiff_epochs,
            "combine": req.combine,
            "title": req.title,
            "area_km2": round(area_km2(geom), 2),
            "geometry": mapping(geom),
            "created": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        (job_dir / "job.json").write_text(json.dumps(spec, indent=1))
        self._write_status(job_dir, id=job_id, state="queued", step="queued", progress=0.0, frames=[])
        self.tick()
        return self.record(job_id)

    def running(self) -> int:
        return sum(1 for r in self.list() if r.get("state") == "running")

    def tick(self) -> None:
        """Start queued jobs (oldest first) while below the concurrency limit; clean up now and then."""
        self._ticks += 1
        if self._ticks % CLEANUP_EVERY_TICKS == 1:
            self.cleanup()
        records = self.list()
        slots = self.max_concurrent - sum(1 for r in records if r.get("state") == "running")
        for rec in sorted((r for r in records if r.get("state") == "queued"), key=lambda r: r["id"]):
            if slots <= 0:
                break
            self._launch(self._dir(rec["id"]))
            slots -= 1

    def _launch(self, job_dir: Path) -> None:
        if not self.python.exists():
            self._write_status(job_dir, state="failed", error=f"jobs environment missing: {self.python}")
            return
        # Downloads stage files in TMPDIR; default to the job folder (system /tmp can be small).
        env = {**os.environ, "TMPDIR": os.environ.get("TMPDIR") or str(job_dir)}
        out = open(job_dir / "runner.out", "ab")  # noqa: SIM115 - handed to the child process
        proc = subprocess.Popen(
            [str(self.python), "-m", "disp_portal.prepare", str(job_dir / "job.json")],
            cwd=PORTAL,
            stdout=out,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            env=env,
        )
        out.close()
        self._write_status(job_dir, state="running", step="starting", pid=proc.pid)

    def cancel(self, job_id: str) -> dict:
        job_dir = self._dir(job_id)
        status = _read_json(job_dir / "status.json") or {}
        if status.get("state") in TERMINAL:
            return self.record(job_id)
        pid = status.get("pid")
        if status.get("state") == "running" and _pid_alive(pid):
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._write_status(job_dir, state="cancelled", step="cancelled", finished=datetime.now(UTC).isoformat(timespec="seconds"))
        self.tick()
        return self.record(job_id)

    def delete(self, job_id: str) -> None:
        self.cancel(job_id)
        shutil.rmtree(self._dir(job_id))

    @staticmethod
    def _size(path: Path) -> int:
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())

    def usage(self) -> dict:
        jobs = [d for d in self.root.iterdir() if (d / "job.json").is_file()]
        total = sum(self._size(d) for d in jobs)
        return {
            "jobs": len(jobs),
            "bytes": total,
            "max_bytes": int(self.max_total_gb * 1e9),
            "max_age_days": self.max_age_days,
        }

    def cleanup(self, now: datetime | None = None) -> list[str]:
        """Delete finished jobs older than `max_age_days`, then the oldest finished ones while
        the total exceeds `max_total_gb`. Running and queued jobs are never touched."""
        now = now or datetime.now(UTC)
        removed: list[str] = []
        finished = [r for r in self.list() if r.get("state") in TERMINAL]
        finished.sort(key=lambda r: (r.get("request") or {}).get("created") or "")
        for rec in list(finished):
            created = (rec.get("request") or {}).get("created")
            if created and (now - datetime.fromisoformat(created)).total_seconds() > self.max_age_days * 86400:
                shutil.rmtree(self.root / rec["id"], ignore_errors=True)
                removed.append(rec["id"])
                finished.remove(rec)
        total = self.usage()["bytes"]
        limit = self.max_total_gb * 1e9
        for rec in finished:
            if total <= limit:
                break
            size = self._size(self.root / rec["id"])
            shutil.rmtree(self.root / rec["id"], ignore_errors=True)
            removed.append(rec["id"])
            total -= size
        return removed

    def file_path(self, job_id: str, rel: str) -> Path:
        job_dir = self._dir(job_id).resolve()
        target = (job_dir / rel).resolve()
        if job_dir not in target.parents or not target.is_file():
            raise KeyError(rel)
        return target

import json
import stat
import time

import pytest

from disp_portal.jobs import JobManager, JobRequest, _pid_alive

BOX = (-95.39, 29.75, -95.37, 29.77)


def _stub_python(tmp_path, body: str):
    """A fake interpreter: `stub -m disp_portal.prepare job.json` runs `body` with $JOB set."""
    script = tmp_path / "python"
    script.write_text(
        "#!/usr/bin/env bash\n"
        'JOB="$3"; DIR="$(dirname "$JOB")"\n'
        f"{body}\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _wait(mgr, job_id, states, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        rec = mgr.record(job_id)
        if rec["state"] in states:
            return rec
        time.sleep(0.1)
    raise AssertionError(f"job stayed {mgr.record(job_id)['state']}")


def test_request_validation():
    assert JobRequest(bbox=BOX, directions=["Ascending", "DESC", "asc"]).directions == ["asc", "desc"]
    with pytest.raises(ValueError):
        JobRequest(bbox=BOX, directions=["north"])
    with pytest.raises(ValueError):
        JobRequest(bbox=BOX, geometry={"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(ValueError):
        JobRequest(bbox=BOX, start="2024-01-01", end="2023-01-01")
    with pytest.raises(ValueError, match="limit"):
        JobRequest(bbox=(-100, 25, -90, 35)).area()
    with pytest.raises(ValueError, match="polygon"):
        JobRequest(geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]}).area()


def test_job_runs_and_reports(tmp_path):
    stub = _stub_python(
        tmp_path,
        'echo \'{"state": "done", "step": "finished", "progress": 1.0, "frames": [{"frame": 8882, "direction": "asc", "state": "done", "cube": "out/F08882_asc.zarr"}]}\' > "$DIR/status.json"\n'
        'mkdir -p "$DIR/out/F08882_asc.zarr" && echo "{}" > "$DIR/out/F08882_asc.zarr/zarr.json"\n'
        'echo "hello from runner" > "$DIR/job.log"',
    )
    mgr = JobManager(root=tmp_path / "jobs", python=stub, max_concurrent=2)
    rec = mgr.create(JobRequest(bbox=BOX, start="2023-01-01", end="2023-03-31"))
    spec = json.loads((tmp_path / "jobs" / rec["id"] / "job.json").read_text())
    assert spec["area_km2"] == pytest.approx(4.3, rel=0.1)
    assert spec["start"] == "2023-01-01" and spec["directions"] == ["asc", "desc"]
    done = _wait(mgr, rec["id"], {"done"})
    assert done["frames"][0]["cube"] == "out/F08882_asc.zarr"
    assert mgr.record(rec["id"], log_lines=5)["log"] == ["hello from runner"]
    assert mgr.file_path(rec["id"], "out/F08882_asc.zarr/zarr.json").is_file()
    with pytest.raises(KeyError):
        mgr.file_path(rec["id"], "../../etc/passwd")
    assert [r["id"] for r in mgr.list()] == [rec["id"]]
    mgr.delete(rec["id"])
    assert mgr.list() == []


def test_concurrency_limit_queue_and_cancel(tmp_path):
    stub = _stub_python(tmp_path, "sleep 30")
    mgr = JobManager(root=tmp_path / "jobs", python=stub, max_concurrent=1)
    a = mgr.create(JobRequest(bbox=BOX))
    time.sleep(1.1)  # distinct second in the id keeps ordering stable
    b = mgr.create(JobRequest(bbox=BOX))
    assert mgr.record(a["id"])["state"] == "running"
    assert mgr.record(b["id"])["state"] == "queued"
    pid = mgr.record(a["id"])["pid"]
    assert mgr.cancel(a["id"])["state"] == "cancelled"
    end = time.time() + 5
    while _pid_alive(pid) and time.time() < end:
        time.sleep(0.1)
    assert not _pid_alive(pid)
    # cancelling a frees the slot: b starts
    assert mgr.record(b["id"])["state"] == "running"
    mgr.cancel(b["id"])


def test_dead_runner_is_reported(tmp_path):
    stub = _stub_python(tmp_path, "exit 3")  # never writes a final status
    mgr = JobManager(root=tmp_path / "jobs", python=stub, max_concurrent=1)
    rec = mgr.create(JobRequest(bbox=BOX))
    failed = _wait(mgr, rec["id"], {"failed"})
    assert "stopped unexpectedly" in failed["error"]


def test_missing_environment(tmp_path):
    mgr = JobManager(root=tmp_path / "jobs", python=tmp_path / "nope" / "python")
    rec = mgr.create(JobRequest(bbox=BOX))
    assert rec["state"] == "failed" and "jobs environment missing" in rec["error"]


def _finished_job(root, job_id, created, size=1000, state="done"):
    d = root / job_id
    d.mkdir(parents=True)
    (d / "job.json").write_text(json.dumps({"id": job_id, "created": created}))
    (d / "status.json").write_text(json.dumps({"id": job_id, "state": state}))
    (d / "blob.bin").write_bytes(b"x" * size)


def test_cleanup_by_age_and_size(tmp_path):
    from datetime import UTC, datetime

    root = tmp_path / "jobs"
    root.mkdir()
    _finished_job(root, "old", "2026-08-01T00:00:00+00:00")
    _finished_job(root, "mid", "2026-09-28T00:00:00+00:00", size=4000)
    _finished_job(root, "new", "2026-10-02T00:00:00+00:00", size=4000)
    _finished_job(root, "busy", "2026-07-01T00:00:00+00:00", size=9000, state="queued")
    mgr = JobManager(root=root, python=tmp_path / "py", max_age_days=30, max_total_gb=14_000 / 1e9)
    removed = mgr.cleanup(now=datetime(2026, 10, 3, tzinfo=UTC))
    # "old" is past 30 days; then the total (busy 9000 + mid 4000 + new 4000 + small json) is
    # over 14 kB, so the oldest finished one ("mid") goes, which brings it under; the
    # queued job is never removed.
    assert removed == ["old", "mid"]
    assert sorted(p.name for p in root.iterdir()) == ["busy", "new"]
    usage = mgr.usage()
    assert usage["jobs"] == 2 and usage["bytes"] > 13_000

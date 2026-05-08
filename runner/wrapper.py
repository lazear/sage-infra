#!/usr/bin/env python3
"""sage-infra runner wrapper.

Invoked inside the Docker image by AWS Batch. Reads commit + dataset metadata
from env vars, hands sage the s3:// URI of the dataset's config.json (sage
reads it directly via its cloudpath layer), parses identification + runtime
metrics from sage's stderr, and uploads a per-(commit, dataset) result JSON
+ log + raw outputs to the results bucket.

Sage already self-reports the metrics we care about (see
sage/crates/sage-cli/src/main.rs:212, 411, 427-432, 502), so we read its log
rather than parsing parquet or relying on /usr/bin/time. Peak memory comes
from getrusage(RUSAGE_CHILDREN).ru_maxrss which is exact and free.
"""

from __future__ import annotations

import json
import os
import re
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3

SCHEMA_VERSION = 1
SCRATCH_OUT = Path("/scratch/out")
LOG_PATH = Path("/scratch/sage.log")


def env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"[wrapper] missing required env var: {name}")
    return val


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def run_sage(config_uri: str) -> tuple[int, str, float, int]:
    """Returns (exit_code, combined_log, wall_seconds, peak_rss_kb)."""
    SCRATCH_OUT.mkdir(parents=True, exist_ok=True)
    cmd = ["sage", config_uri, "-o", str(SCRATCH_OUT), "--parquet"]
    print(f"[wrapper] $ {' '.join(cmd)}", flush=True)

    t0 = time.monotonic()
    # Stream sage's combined stdout+stderr to our own stdout (visible in
    # CloudWatch in real time) and tee to LOG_PATH for parsing + S3 upload.
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    chunks: list[str] = []
    with open(LOG_PATH, "w") as logf:
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            logf.write(line)
            chunks.append(line)
    rc = proc.wait()
    wall = time.monotonic() - t0

    # Linux: ru_maxrss is in KB. RUSAGE_CHILDREN tracks terminated children.
    peak_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss

    return rc, "".join(chunks), wall, peak_kb


# Match Sage's own stderr lines. Patterns are anchored on the substantive
# text rather than the env_logger prefix so they survive logger format changes.
_METRIC_PATTERNS = {
    "psms":      re.compile(r"discovered\s+(\d+)\s+target peptide-spectrum matches"),
    "peptides":  re.compile(r"discovered\s+(\d+)\s+target peptides"),
    "proteins":  re.compile(r"discovered\s+(\d+)\s+target proteins"),
    "protein_groups":  re.compile(r"discovered\s+(\d+)\s+target protein groups"),
}
_SEARCH_PATTERN = re.compile(r"search:\s+(\d+)\s+ms\s+\((\d+)\s+spectra/s\)")
_FINISHED_PATTERN = re.compile(r"finished in\s+(\d+(?:\.\d+)?)\s*s")


def parse_metrics(log: str) -> dict[str, Any]:
    out: dict[str, Any] = {k: None for k in _METRIC_PATTERNS}
    out["search_ms"] = None
    out["throughput_spectra_per_sec"] = None
    out["sage_reported_seconds"] = None
    for key, pat in _METRIC_PATTERNS.items():
        m = pat.search(log)
        if m:
            out[key] = int(m.group(1))
    if (m := _SEARCH_PATTERN.search(log)):
        out["search_ms"] = int(m.group(1))
        out["throughput_spectra_per_sec"] = int(m.group(2))
    if (m := _FINISHED_PATTERN.search(log)):
        out["sage_reported_seconds"] = float(m.group(1))
    return out


def upload_outputs(s3, bucket: str, commit: str, dataset: str, result_doc: dict[str, Any]) -> None:
    prefix = f"results/{commit}/{dataset}"

    # Authoritative per-run summary (consumed by the dashboard's index.json).
    s3.put_object(
        Bucket=bucket,
        Key=f"{prefix}.json",
        Body=json.dumps(result_doc, indent=2).encode("utf-8"),
        ContentType="application/json",
    )

    # Combined stdout/stderr — small and useful for diagnosing regressions, kept indefinitely.
    if LOG_PATH.exists():
        s3.upload_file(
            str(LOG_PATH), bucket, f"{prefix}.log",
            ExtraArgs={"ContentType": "text/plain; charset=utf-8"},
        )

    # Sage's heavy outputs (parquet/tsv) are intentionally NOT persisted: the
    # commit + config + bucket of mzMLs are sufficient to reproduce them, and
    # storing every revision's outputs would balloon S3 cost for no win.


def sage_version() -> str:
    try:
        v = subprocess.run(["sage", "--version"], capture_output=True, text=True, timeout=10)
        return (v.stdout or v.stderr).strip()
    except Exception:
        return ""


def main() -> int:
    commit = env("COMMIT")
    dataset = env("DATASET")
    data_bucket = env("DATA_BUCKET")
    results_bucket = env("RESULTS_BUCKET")

    image_uri          = os.environ.get("IMAGE_URI", "")
    sage_repo          = os.environ.get("SAGE_REPO", "lazear/sage")
    commit_message     = os.environ.get("COMMIT_MESSAGE", "")
    commit_author      = os.environ.get("COMMIT_AUTHOR", "")
    commit_timestamp   = os.environ.get("COMMIT_TIMESTAMP", "")
    batch_job_id       = os.environ.get("AWS_BATCH_JOB_ID", "")
    sage_infra_commit  = os.environ.get("SAGE_INFRA_COMMIT", "")

    s3 = boto3.client("s3")

    started_at = now_iso()
    # Configs live in git and are staged by the build job to a per-commit prefix.
    cfg_uri = f"s3://{data_bucket}/staging/{commit}/{dataset}/config.json"
    print(f"[wrapper] config: {cfg_uri}", flush=True)
    version_str = sage_version()
    exit_code, log, wall_seconds, peak_kb = run_sage(cfg_uri)
    ended_at = now_iso()
    metrics = parse_metrics(log)

    result = {
        "schema_version": SCHEMA_VERSION,
        "commit": commit,
        "commit_short": commit[:7],
        "commit_url": f"https://github.com/{sage_repo}/commit/{commit}",
        "commit_message": commit_message,
        "commit_author": commit_author,
        "commit_timestamp": commit_timestamp,
        "dataset": dataset,
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_seconds": round(wall_seconds, 3),
        "peak_memory_kb": peak_kb,
        "sage_version": version_str,
        "sage_infra_commit": sage_infra_commit,
        "image_uri": image_uri,
        "batch_job_id": batch_job_id,
        "exit_code": exit_code,
        "log_key": f"results/{commit}/{dataset}.log",
        **metrics,
    }

    upload_outputs(s3, results_bucket, commit, dataset, result)
    if exit_code != 0:
        sys.stderr.write(f"[wrapper] sage exited {exit_code}\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

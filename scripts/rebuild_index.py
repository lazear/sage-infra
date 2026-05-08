#!/usr/bin/env python3
"""Rebuild s3://<results-bucket>/index.json from per-run summary JSONs.

Lists every object matching results/<commit>/<dataset>.json in the results
bucket, fetches each, reads per-commit manifests when available, fills in
missing dataset results, sorts by commit_timestamp desc, and uploads the
concatenation as index.json at the bucket root.

Usage:  rebuild_index.py <results-bucket>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import boto3


def is_summary_key(key: str) -> bool:
    # Expect: results/<commit>/<dataset>.json (exactly two segments after results/)
    if not key.startswith("results/") or not key.endswith(".json"):
        return False
    parts = key[len("results/"):].split("/")
    return len(parts) == 2


def is_manifest_key(key: str) -> bool:
    return key.startswith("manifests/") and key.endswith(".json")


def expected_datasets(root: Path = Path("datasets")) -> list[str]:
    return sorted(path.parent.name for path in root.glob("*/config.json"))


def missing_result_doc(commit: str, dataset: str, sample: dict[str, Any] | None) -> dict[str, Any]:
    sample = sample or {}
    return {
        "schema_version": sample.get("schema_version", 1),
        "commit": commit,
        "commit_short": sample.get("commit_short") or commit[:7],
        "commit_url": sample.get("commit_url"),
        "commit_message": sample.get("commit_message", ""),
        "commit_author": sample.get("commit_author", ""),
        "commit_timestamp": sample.get("commit_timestamp", ""),
        "dataset": dataset,
        "started_at": None,
        "ended_at": None,
        "duration_seconds": None,
        "peak_memory_kb": None,
        "sage_version": sample.get("sage_version", ""),
        "sage_infra_commit": sample.get("sage_infra_commit", ""),
        "image_uri": sample.get("image_uri", ""),
        "batch_job_id": None,
        "exit_code": None,
        "missing_result": True,
        "log_key": None,
        "psms": None,
        "peptides": None,
        "proteins": None,
        "protein_groups": None,
        "search_ms": None,
        "throughput_spectra_per_sec": None,
        "sage_reported_seconds": None,
    }


def add_manifest_missing_results(
    docs: list[dict[str, Any]],
    manifests: list[dict[str, Any]],
    fallback_datasets: list[str],
) -> int:
    by_commit: dict[str, list[dict[str, Any]]] = {}
    for doc in docs:
        commit = doc.get("commit")
        if isinstance(commit, str) and commit:
            by_commit.setdefault(commit, []).append(doc)

    manifest_by_commit = {
        manifest["commit"]: manifest
        for manifest in manifests
        if isinstance(manifest.get("commit"), str) and manifest.get("commit")
    }

    added = 0
    for commit in sorted(set(by_commit) | set(manifest_by_commit)):
        commit_docs = by_commit.get(commit, [])
        manifest = manifest_by_commit.get(commit, {})
        datasets = manifest.get("datasets") or fallback_datasets
        if not isinstance(datasets, list):
            continue
        present = {d.get("dataset") for d in commit_docs}
        sample = commit_docs[0] if commit_docs else manifest
        for dataset in sorted(d for d in datasets if isinstance(d, str) and d):
            if dataset in present:
                continue
            docs.append(missing_result_doc(commit, dataset, sample))
            added += 1
    return added


def main(bucket: str) -> int:
    s3 = boto3.client("s3")

    docs: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    paginator = s3.get_paginator("list_objects_v2")
    for prefix in ("results/", "manifests/"):
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                if prefix == "results/" and not is_summary_key(key):
                    continue
                if prefix == "manifests/" and not is_manifest_key(key):
                    continue
                body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
                try:
                    doc = json.loads(body)
                except json.JSONDecodeError:
                    print(f"[rebuild] skipping malformed {key}", file=sys.stderr)
                    continue
                if not isinstance(doc, dict):
                    continue
                if prefix == "results/" and "schema_version" in doc:
                    docs.append(doc)
                elif prefix == "manifests/":
                    manifests.append(doc)

    datasets = expected_datasets()
    missing = add_manifest_missing_results(docs, manifests, datasets)

    docs.sort(
        key=lambda d: (
            d.get("commit_timestamp") or d.get("started_at") or "",
            d.get("dataset") or "",
        ),
        reverse=True,
    )

    body = json.dumps(docs, indent=2).encode("utf-8")
    s3.put_object(
        Bucket=bucket,
        Key="index.json",
        Body=body,
        ContentType="application/json",
        CacheControl="no-cache, no-store, must-revalidate",
    )
    print(
        f"[rebuild] wrote index.json with {len(docs)} entries "
        f"({missing} missing, {len(body)} bytes)"
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: rebuild_index.py <results-bucket>")
    sys.exit(main(sys.argv[1]))

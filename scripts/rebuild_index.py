#!/usr/bin/env python3
"""Rebuild s3://<results-bucket>/index.json from per-run summary JSONs.

Lists every object matching results/<commit>/<dataset>.json in the results
bucket, fetches each, sorts by commit_timestamp desc, and uploads the
concatenation as index.json at the bucket root.

Usage:  rebuild_index.py <results-bucket>
"""

from __future__ import annotations

import json
import sys
from typing import Any

import boto3


def is_summary_key(key: str) -> bool:
    # Expect: results/<commit>/<dataset>.json (exactly two segments after results/)
    if not key.startswith("results/") or not key.endswith(".json"):
        return False
    parts = key[len("results/"):].split("/")
    return len(parts) == 2


def main(bucket: str) -> int:
    s3 = boto3.client("s3")

    docs: list[dict[str, Any]] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="results/"):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if not is_summary_key(key):
                continue
            body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            try:
                doc = json.loads(body)
            except json.JSONDecodeError:
                print(f"[rebuild] skipping malformed {key}", file=sys.stderr)
                continue
            if not isinstance(doc, dict) or "schema_version" not in doc:
                continue
            docs.append(doc)

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
    print(f"[rebuild] wrote index.json with {len(docs)} entries ({len(body)} bytes)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: rebuild_index.py <results-bucket>")
    sys.exit(main(sys.argv[1]))

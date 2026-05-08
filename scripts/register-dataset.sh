#!/usr/bin/env bash
# Register / unregister a dataset in s3://${DATA_BUCKET}/datasets/index.json.
# This file is the authoritative list the benchmark workflow reads to build
# its fanout matrix.
#
# Usage:
#   DATA_BUCKET=...  ./scripts/register-dataset.sh PXD001468            # add
#   DATA_BUCKET=...  ./scripts/register-dataset.sh --remove PXD001468   # remove
set -euo pipefail

ACTION=add
if [ "${1:-}" = "--remove" ]; then ACTION=remove; shift; fi
DATASET="${1:?dataset id required (e.g. PXD001468)}"
: "${DATA_BUCKET:?DATA_BUCKET env var required}"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if aws s3 ls "s3://${DATA_BUCKET}/datasets/index.json" >/dev/null 2>&1; then
  aws s3 cp "s3://${DATA_BUCKET}/datasets/index.json" "$TMP"
else
  echo '[]' > "$TMP"
fi

if [ "$ACTION" = "add" ]; then
  NEW=$(jq --arg id "$DATASET" \
    'if any(.id == $id) then . else . + [{id:$id}] end' "$TMP")
else
  NEW=$(jq --arg id "$DATASET" 'map(select(.id != $id))' "$TMP")
fi

echo "$NEW" > "$TMP"
aws s3 cp "$TMP" "s3://${DATA_BUCKET}/datasets/index.json" --content-type application/json
echo "current dataset list:"
echo "$NEW" | jq .

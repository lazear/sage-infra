#!/usr/bin/env bash
# Upload a local dataset's mzML files + FASTA to the data bucket.
#
# The sage config.json now lives in git at datasets/<PXD>/config.json — this
# script only ships the heavy data files. Use ${DATA_BUCKET} placeholders in
# the committed config to refer to s3://${DATA_BUCKET}/datasets/<PXD>/<file>.
#
# Usage:   DATA_BUCKET=sage-infra-data-… ./scripts/upload-dataset.sh PXD001468 ./local/PXD001468
#
# The local folder may contain any mix of:
#   *.mzML  *.mzML.gz  *.mzparquet  *.fasta  *.fasta.gz
set -euo pipefail

DATASET="${1:?dataset id required (e.g. PXD001468)}"
LOCAL="${2:?path to local dataset folder required}"
: "${DATA_BUCKET:?DATA_BUCKET env var required}"

DEST="s3://${DATA_BUCKET}/datasets/${DATASET}/"
echo "→ $DEST"
aws s3 sync "$LOCAL/" "$DEST" \
  --exclude '*' \
  --include '*.mzML.gz' \
  --include '*.fasta' \
  --size-only

echo
echo "next: add datasets/${DATASET}/config.json (and optional meta.yaml) to git,"
echo "      then push. The benchmark workflow will stage it per commit."

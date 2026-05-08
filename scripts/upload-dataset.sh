#!/usr/bin/env bash
# Upload a local dataset folder (config.json + mzMLs + FASTA) to the data bucket.
# Authoring conventions:
#   * The folder contains exactly one config.json
#   * config.json references mzML/FASTA paths as s3://${DATA_BUCKET}/datasets/${DATASET}/<filename>
#   * Sage reads s3:// paths natively; the runner only needs config.json on local disk
#
# Usage:   DATA_BUCKET=sage-infra-data-… ./scripts/upload-dataset.sh PXD001468 ./local/PXD001468
set -euo pipefail

DATASET="${1:?dataset id required (e.g. PXD001468)}"
LOCAL="${2:?path to local dataset folder required}"
: "${DATA_BUCKET:?DATA_BUCKET env var required}"

if [ ! -f "$LOCAL/config.json" ]; then
  echo "expected $LOCAL/config.json"; exit 1
fi

DEST="s3://${DATA_BUCKET}/datasets/${DATASET}/"
echo "→ $DEST"
aws s3 sync "$LOCAL/" "$DEST" --exclude '.DS_Store' --exclude '*.tmp' --size-only

echo "done. register with: scripts/register-dataset.sh ${DATASET}"

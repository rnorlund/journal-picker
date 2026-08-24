#!/bin/bash
# Full hybrid build for one or more fields:
#   Europe PMC for the volume sweep (unmetered), OpenAlex only for enrichment.
cd ~/journalPicker || exit 1
for f in "$@"; do
  echo "=== $(date -u +%H:%M:%S) VOLUME $f ==="
  FIELD="$f" python3 -u scripts/build-volume-epmc.py >> "epmc-$f.log" 2>&1 || {
    echo "=== $f volume FAILED ==="; continue; }
  echo "=== $(date -u +%H:%M:%S) CATALOG $f ==="
  FIELD="$f" VOLUME_SOURCE=epmc python3 -u scripts/build-catalog.py >> "build-$f.log" 2>&1
  if [ -s "data/catalogs/$f.json" ]; then
    echo "=== $(date -u +%H:%M:%S) DONE $f ($(stat -c%s data/catalogs/$f.json) bytes) ==="
  else
    echo "=== $(date -u +%H:%M:%S) FAILED $f ==="
  fi
done
echo "=== EPMC QUEUE COMPLETE ==="

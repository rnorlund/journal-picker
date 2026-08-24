#!/bin/bash
# Run catalog builds for several fields in sequence on one machine.
# Usage: build-queue.sh field1 field2 ...
# Each field is retried once, because a transient API failure should not cost
# the whole queue -- the builder is checkpointed, so a retry resumes.
cd ~/journalPicker || exit 1
for f in "$@"; do
  echo "=== $(date -u +%H:%M:%S) START $f ==="
  FIELD="$f" python3 -u scripts/build-catalog.py >> "build-$f.log" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "=== $f exited $rc, retrying once ==="
    FIELD="$f" python3 -u scripts/build-catalog.py >> "build-$f.log" 2>&1
    rc=$?
  fi
  if [ -s "data/catalogs/$f.json" ]; then
    echo "=== $(date -u +%H:%M:%S) DONE $f ($(stat -c%s "data/catalogs/$f.json") bytes) ==="
  else
    echo "=== $(date -u +%H:%M:%S) FAILED $f (no output, rc=$rc) ==="
  fi
done
echo "=== QUEUE COMPLETE ==="

#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

files=(
  tf.min.js
  mobilenet.min.js
  chart.umd.min.js
  html2canvas.min.js
  jspdf.umd.min.js
)

missing=0
for file in "${files[@]}"; do
  if [[ ! -s "$SCRIPT_DIR/$file" ]]; then
    printf 'Missing local library: %s\n' "$file" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  printf 'Restore a complete release package; this script does not download dependencies.\n' >&2
  exit 1
fi

printf 'All bundled browser libraries are present.\n'

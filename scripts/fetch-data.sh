#!/usr/bin/env bash
# Download public COPC sample files into public/data/ (git-ignored, too large).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/data

fetch() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then echo "exists: $out"; return; fi
  echo "downloading: $out"
  curl -fSL -o "$out" "$url"
}

# Tiny synthetic file (~0.6 MB) — fast smoke tests.
fetch "https://github.com/connormanning/copc.js/raw/master/src/test/data/ellipsoid.copc.laz" \
      "public/data/ellipsoid.copc.laz"

# Real geolocated LiDAR (~81 MB) — Autzen Stadium, Oregon.
fetch "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz" \
      "public/data/autzen.copc.laz"

echo "done."
ls -la public/data/

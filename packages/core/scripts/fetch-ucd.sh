#!/bin/sh
# Downloads Unicode's conformance test data for the version the crate implements
# (checked against src/lib.rs at test time), verified by SHA-256. Cached in .ucd/.
set -eu
VERSION=17.0.0
DIR="$(cd "$(dirname "$0")/.." && pwd)/.ucd/$VERSION"
mkdir -p "$DIR"
fetch() { # path sha256
  file="$DIR/$(basename "$1")"
  if [ ! -f "$file" ] || ! echo "$2  $file" | sha256sum -c --status; then
    curl -sfL -o "$file" "https://www.unicode.org/Public/$VERSION/ucd/$1"
    echo "$2  $file" | sha256sum -c --quiet
  fi
}
fetch auxiliary/GraphemeBreakTest.txt e2d134d2c52919bace503ebb6a551c1855fe1a1faec18478c78fff254a1793ec
fetch NormalizationTest.txt 5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db

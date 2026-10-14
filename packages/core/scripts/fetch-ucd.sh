#!/bin/sh
# Downloads Unicode's data for the version the crate implements, verified by
# SHA-256, into .ucd/: the conformance tests' data, and the property files that
# `cargo run --example gcb_table` builds src/gcb_table.rs from.
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
fetch auxiliary/GraphemeBreakProperty.txt d6b51d1d2ae5c33b451b7ed994b48f1f4dc62b2272a5831e7fd418514a6bae89
fetch emoji/emoji-data.txt 2cb2bb9455cda83e8481541ecf5b6dfda66a3bb89efa3fa7c5297eccf607b72b
fetch DerivedCoreProperties.txt 24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08

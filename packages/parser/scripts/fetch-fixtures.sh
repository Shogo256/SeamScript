#!/bin/sh
# Downloads upstream's parser test fixtures (inputs and options only) at the commit
# this fork is based on, for test/differential.test.ts. Cached in .fixtures/.
set -eu
COMMIT=1fc00736614159e3b236b9958771f482899853f0 # babel v8.0.7
DIR="$(cd "$(dirname "$0")/.." && pwd)/.fixtures"
if [ -f "$DIR/COMMIT" ] && [ "$(cat "$DIR/COMMIT")" = "$COMMIT" ]; then
  exit 0
fi
rm -rf "$DIR"
mkdir -p "$DIR"
git -C "$DIR" init -q
git -C "$DIR" remote add origin https://github.com/babel/babel.git
git -C "$DIR" sparse-checkout set --no-cone \
  '/packages/babel-parser/test/fixtures/**/input.*' \
  '/packages/babel-parser/test/fixtures/**/options.json'
git -C "$DIR" fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
git -C "$DIR" checkout -q FETCH_HEAD
echo "$COMMIT" > "$DIR/COMMIT"

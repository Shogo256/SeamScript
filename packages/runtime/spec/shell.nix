# TLC for latest.tla. Deliberately not in the repository's main shell.nix: the
# JVM is heavy and this spec is only re-checked when latest.ts changes.
# Same nixpkgs revision as ../../../shell.nix.
{ pkgs ? import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/31cd72fdba8fa052e437ce7e6879c4fe62def10f.tar.gz";
    sha256 = "sha256-VI5cdo27nEZ3m1SlgB8RvBbrqFUO2/dUgrrLWe407oA=";
  }) {} }:
pkgs.mkShell {
  packages = [ pkgs.tlaplus ];
}

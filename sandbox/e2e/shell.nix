# The repository's shell plus Playwright's three browsers from nixpkgs, with every
# library they link. The browsers Playwright downloads do not all run here (its
# WebKit needs libavif.so.16, which Ubuntu 26.04 does not ship), and these are
# pinned with the rest of the toolchain. @playwright/test must stay at the
# version nixpkgs packages (1.61.1 at this revision) so the browser revisions match.
# Same nixpkgs revision as ../../shell.nix.
{ pkgs ? import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/31cd72fdba8fa052e437ce7e6879c4fe62def10f.tar.gz";
    sha256 = "sha256-VI5cdo27nEZ3m1SlgB8RvBbrqFUO2/dUgrrLWe407oA=";
  }) {} }:
(import ../../shell.nix { inherit pkgs; }).overrideAttrs (old: {
  PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
  # Its check runs ldd from the nix glibc, which cannot see the libraries anyway.
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
  # WPE WebKit needs an EGL display. Outside NixOS there is no /run/opengl-driver
  # for nix's libglvnd to find, so point it at Mesa's (software rendering).
  __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
  LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
  GBM_BACKENDS_PATH = "${pkgs.mesa}/lib/gbm";
})

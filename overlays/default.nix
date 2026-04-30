# Additional overlays beyond neovim-nightly-overlay
# Applied in flake.nix alongside neovim-nightly-overlay.overlays.default
inputs: _final: prev: {
  arto = inputs.arto.packages.${prev.stdenv.hostPlatform.system}.default;
  opencode = inputs.opencode.packages.${prev.stdenv.hostPlatform.system}.default;
}

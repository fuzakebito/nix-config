# Additional overlays beyond neovim-nightly-overlay
# Applied in flake.nix alongside neovim-nightly-overlay.overlays.default
inputs: final: prev: {
  dsh = final.callPackage ./dsh { };
  rdsh = final.callPackage ./rdsh.nix { };
  arto = inputs.arto.packages.${prev.stdenv.hostPlatform.system}.default;
  herdr = inputs.herdr.packages.${prev.stdenv.hostPlatform.system}.default;
}

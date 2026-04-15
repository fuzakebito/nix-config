{ pkgs, ... }:

{
  # neovim nightly via neovim-nightly-overlay (applied in flake.nix)
  home.packages = [ pkgs.neovim ];

  # Deploy nvim config (recursive = true allows dein to write to ~/.cache/dein)
  xdg.configFile."nvim" = {
    source = ./files/nvim;
    recursive = true;
  };
}

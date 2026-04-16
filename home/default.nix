{ config, pkgs, ... }:

{
  imports = [
    ./packages.nix
    ./git.nix
    ./zsh
    ./neovim.nix
    ./terminals.nix
    ./files.nix
    ./services.nix
    ./cloudflared.nix
  ];

  home.username = "fuzakebito";
  home.homeDirectory = "/home/fuzakebito";
  home.stateVersion = "25.11";

  # Arch Linux: integrate XDG_DATA_DIRS for non-NixOS
  targets.genericLinux.enable = true;

  # Let Home Manager manage itself
  programs.home-manager.enable = true;
}

{ config, pkgs, isArch, isNixOS, ... }:

{
  imports = [
    ./packages.nix
    ./git.nix
    ./zsh
    ./neovim.nix
    ./terminals.nix
    ./files.nix
    ./services.nix
    ./opencode.nix
    ./sway
    ./rofi
    ./paru
    ./waybar
  ];

  home.username = "fuzakebito";
  home.homeDirectory = "/home/fuzakebito";
  home.stateVersion = "25.11";

  # Non-NixOS (Arch, etc.): integrate XDG_DATA_DIRS. No-op on NixOS.
  targets.genericLinux.enable = !isNixOS;

  # Let Home Manager manage itself
  programs.home-manager.enable = true;
}

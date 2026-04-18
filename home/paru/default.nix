{ lib, isArch, ... }:

lib.mkIf isArch {
  # paru is an Arch AUR helper; it has no meaning on NixOS.
  # The paru binary is managed by pacman/AUR (libalpm version must match
  # the system pacman — Q4b decision). HM owns the config only.
  xdg.configFile."paru/paru.conf".source = ./files/paru.conf;
}

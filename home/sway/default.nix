{ lib, ... }:

{
  # sway config is raw copy (wayland.windowManager.sway module is NOT used).
  # sway binary comes from system level (Arch=pacman / NixOS=system). HM owns config only.
  xdg.configFile."sway" = {
    source = ./files;
    recursive = true;
  };

  # Belt-and-suspenders: explicitly enforce executable bit on ime.sh
  # (git mode 100755 already covers this, but `lib.mkForce` guards against
  # any future `lib.cleanSourceWith` filter that might strip permissions).
  home.file.".config/sway/scripts/ime.sh" = lib.mkForce {
    source = ./files/scripts/ime.sh;
    executable = true;
  };
}

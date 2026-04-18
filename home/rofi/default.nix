{ ... }:

{
  # DECISION-2 (full declarative): launcher CLI flags moved into programs.rofi.*
  # so the custom rofi_launch.sh is retired. rofi binary comes from nixpkgs
  # on both platforms (Q3b: the Arch pacman rofi will be removed in T16).
  programs.rofi = {
    enable = true;
    font = "Jost* Light 15";
    terminal = "env WINIT_UNIX_BACKEND=x11 alacritty";
    # theme = path → HM places the file at ~/.local/share/rofi/themes/
    # and emits `@theme "Black-Simplicity"` into ~/.config/rofi/config.rasi.
    theme = ./files/Black-Simplicity.rasi;
    extraConfig = {
      modi = "combi,drun,run,window,ssh";
      combi-modi = "window,drun,run";
      show-icons = true;
      sidebar-mode = true;
    };
  };

  # X11 launcher retained (env exports cannot be expressed in programs.rofi.*).
  # Contents are simplified: env exports + `rofi -show combi` only.
  xdg.configFile."rofi/rofi_Xlaunch.sh" = {
    source = ./files/rofi_Xlaunch.sh;
    executable = true;
  };
}

{ ... }:

{
  # Terminal emulator binaries stay in pacman (need host GPU/display access).
  # Home-manager manages config files only.

  xdg.configFile."alacritty/alacritty.toml".source = ./files/alacritty.toml;
  xdg.configFile."foot/foot.ini".source = ./files/foot.ini;
  xdg.configFile."wezterm" = {
    source = ./files/wezterm;
    recursive = true;
  };
}

{ pkgs, ... }:

{
  # Alacritty
  programs.alacritty = {
    enable = true;
  };
  xdg.configFile."alacritty/alacritty.toml".source = ./files/alacritty.toml;

  # Foot terminal  
  programs.foot = {
    enable = true;
  };
  xdg.configFile."foot/foot.ini".source = ./files/foot.ini;

  # Wezterm (no programs.wezterm module available in this home-manager version)
  home.packages = [ pkgs.wezterm ];
  xdg.configFile."wezterm" = {
    source = ./files/wezterm;
    recursive = true;
  };
}

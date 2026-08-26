{ pkgs, ... }:

{
  # tmux
  programs.tmux = {
    enable = true;
    shell = "${pkgs.zsh}/bin/zsh";
    extraConfig = builtins.readFile ./files/tmux.conf;
  };

  # Herdr mirrors the tmux keymap and status layout where supported.
  xdg.configFile."herdr/config.toml".text = ''
    [theme]
    name = "terminal"

    [theme.custom]
    accent = "cyan"
    active_row_bg = "black"
    selection_bg = "black"

    [terminal]
    default_shell = "${pkgs.zsh}/bin/zsh"
    new_cwd = "follow"

    [keys]
    prefix = "ctrl+z"
    previous_tab = "prefix+shift+n"

    [ui]
    mouse_capture = true
    prompt_new_tab_name = false
    pane_outer_borders = false
    pane_scrollbars = false
    pane_gaps = false
    tab_bar_position = "top"
    tab_bar_right = [{ type = "hostname" }]
    window_title = "{hostname}: {workspace}:{tab}"
  '';

  # bashrc
  home.file.".bashrc".source = ./files/bashrc;

  # LaTeX config
  home.file.".latexmkrc".source = ./files/latexmkrc;

  # mise config
  xdg.configFile."mise" = {
    source = ./files/mise;
    recursive = true;
  };

  # xremap config
  xdg.configFile."xremap" = {
    source = ./files/xremap;
    recursive = true;
  };

  # bin scripts
  home.file.".local/bin/serve.ts".source = ./files/bin/serve.ts;
  home.file.".local/bin/uqzaiko".source = ./files/bin/uqzaiko;
}

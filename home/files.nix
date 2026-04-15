{ pkgs, ... }:

{
  # tmux
  programs.tmux = {
    enable = true;
    extraConfig = builtins.readFile ./files/tmux.conf;
  };

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

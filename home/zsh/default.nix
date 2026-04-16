{ config, lib, pkgs, ... }:

let
  zsh-defer-src = pkgs.fetchFromGitHub {
    owner = "romkatv";
    repo = "zsh-defer";
    rev = "53a26e287fbbe2dcebb3aa1801546c6de32416fa";
    sha256 = "0m8xhzdqy2fbd1vj2vy95xjij4vz547i9lbdj6h794n2fc16yn9h";
  };

  zeno-src = pkgs.fetchFromGitHub {
    owner = "yuki-yano";
    repo = "zeno.zsh";
    rev = "2e8fbecce0fc3692a5fcc9033ecca7ab35263e56";
    sha256 = "1mjhl82rr2jlgnz9rvnldpbhijyxrv5illxjyylp4j7zcgav17yk";
  };

  ni-src = pkgs.fetchFromGitHub {
    owner = "azu";
    repo = "ni.zsh";
    rev = "72ddee65fc1f6c6fa436ea01521896a083cd986a";
    sha256 = "0hy95wxs3caxvab9csy8jg8ghy4jvqfkwwcnbjkjbfp1fsvy239v";
  };

  autoswitch-venv-src = pkgs.fetchFromGitHub {
    owner = "MichaelAquilina";
    repo = "zsh-autoswitch-virtualenv";
    rev = "9020833b13f8982d1fdc0d1541ccdc87670beb23";
    sha256 = "0z1n7b38s6dzsqlyi5frssdsk5vc2qvkg57j3fvg8vhqwzw1frlg";
  };

  p10k-config = ./files/p10k.zsh;
  lazy-config = ./files/lazy.zsh;
  zeno-atinit = ./files/zeno_atinit.zsh;
  zeno-atload = ./files/zeno_atload.zsh;
in
{
  programs.zsh = {
    enable = true;
    enableCompletion = false;
    dotDir = "${config.xdg.configHome}/zsh";

    history = {
      size = 1000000;
      save = 1000000;
      path = "$HOME/.zsh_hist";
      extended = true;
      ignoreDups = true;
      ignoreAllDups = true;
      share = true;
    };

    defaultKeymap = "viins";

    shellAliases = {
      eza = "eza -a --group-directories-first --icons --git";
      toilet = "toilet -w $(tput cols)";
      fzf = "fzf --prompt=' ' --pointer='❯' --marker='󰄬' --color='hl:6,hl+:14,bg+:-1,info:-1,prompt:6,pointer:6,marker:2,header:1'";
      fetch = "fastfetch";
    };

    initContent = lib.mkMerge [
      (lib.mkBefore ''
        setopt hist_reduce_blanks
        setopt hist_no_store
        setopt autocd
        setopt extendedglob
        setopt noflowcontrol
        setopt correct
        setopt interactivecomments
        unsetopt beep
        KEYTIMEOUT=2

        # Prevent zcompile from trying to write to read-only /nix/store paths
        function ensure_zcompiled {
          local compiled="$1.zwc"
          [[ "$1" == /nix/store/* ]] && return
          if [[ ! -r "$compiled" || "$1" -nt "$compiled" ]]; then
            zcompile "$1"
          fi
        }
        function source {
          ensure_zcompiled "$1"
          builtin source "$1"
        }
      '')
      ''
        # ---- Keybindings (from nonlazy.zsh) ----
        bindkey "^[[A" history-beginning-search-backward
        bindkey "^[[B" history-beginning-search-forward
        bindkey "^[[3~" delete-char
        bindkey "^[[1~" beginning-of-line
        bindkey "^[[H" beginning-of-line
        bindkey "^[[4~" end-of-line
        bindkey "^[[F" end-of-line
        autoload -Uz edit-command-line
        zle -N edit-command-line
        bindkey '^xe' edit-command-line

        # ---- Plugin Loading ----

        # 1. zsh-defer (load immediately)
        source ${zsh-defer-src}/zsh-defer.plugin.zsh

        # 2. powerlevel10k (immediate load)
        ZLE_RPROMPT_INDENT=0
        source ${p10k-config}
        source ${pkgs.zsh-powerlevel10k}/share/zsh/themes/powerlevel10k/powerlevel10k.zsh-theme

        # 3. zeno (deferred)
        # Copy zeno source to writable cache — deno creates node_modules/.deno
        # adjacent to the script, which fails in read-only /nix/store
        ZSHRC_DIR="$HOME/.config/zsh"
        _zeno_cache="$HOME/.cache/zsh-plugins/zeno"
        _zeno_marker="$_zeno_cache/.nix-store-path"
        if [[ ! -f "$_zeno_marker" ]] || [[ "$(< "$_zeno_marker")" != "${zeno-src}" ]]; then
          command rm -rf "$_zeno_cache"
          command mkdir -p "$_zeno_cache"
          command cp -r ${zeno-src}/. "$_zeno_cache/"
          command chmod -R u+w "$_zeno_cache"
          printf '%s' '${zeno-src}' > "$_zeno_marker"
        fi
        zsh-defer source ${zeno-atinit}
        zsh-defer source "$_zeno_cache/zeno.zsh"
        zsh-defer source ${zeno-atload}

        # 4. fzf-tab (deferred)
        zsh-defer source ${pkgs.zsh-fzf-tab}/share/fzf-tab/fzf-tab.plugin.zsh

        # 5. fast-syntax-highlighting / F-Sy-H (deferred)
        zsh-defer source ${pkgs.zsh-fast-syntax-highlighting}/share/zsh/plugins/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh

        # 6. zsh-completions (before compinit)
        fpath+=(${pkgs.zsh-completions}/share/zsh/site-functions)

        # 7. ni.zsh (deferred)
        zsh-defer source ${ni-src}/ni.zsh

        # 8. autoswitch-virtualenv (deferred)
        zsh-defer source ${autoswitch-venv-src}/autoswitch_virtualenv.plugin.zsh

        # 9. lazy.zsh - deferred config
        zsh-defer source ${lazy-config}

        # 10. compinit (deferred, after completions)
        zsh-defer -t 0.001 autoload -Uz compinit
        zsh-defer -t 0.001 compinit

        # 11. Remove source override
        zsh-defer zsh-defer unfunction source
      ''
    ];
  };

  home.sessionVariables = {
    EDITOR = "nvim";
    BAT_THEME = "base16";
    MANPAGER = "nvim +Man!";
    PNPM_HOME = "$HOME/.local/share/pnpm";
    DENO_INSTALL = "$HOME/.deno";
    LESS_TERMCAP_mb = "$'\\e[1;32m'";
    LESS_TERMCAP_md = "$'\\e[1;32m'";
    LESS_TERMCAP_me = "$'\\e[0m'";
    LESS_TERMCAP_se = "$'\\e[0m'";
    LESS_TERMCAP_so = "$'\\e[01;33m'";
    LESS_TERMCAP_ue = "$'\\e[0m'";
    LESS_TERMCAP_us = "$'\\e[1;4;31m'";
  };

  home.sessionPath = [
    "$HOME/asobi/bin"
    "$HOME/go/bin"
    "$HOME/.deno/bin"
    "$HOME/.local/share/pnpm"
    "$HOME/.cargo/bin"
    "$HOME/.local/bin"
  ];

  xdg.configFile."zsh/plugrc/zeno" = {
    source = ./files/zeno-config;
    recursive = true;
  };
}

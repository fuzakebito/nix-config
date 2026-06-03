{ pkgs, ... }:

{
  home.packages = with pkgs; [
    # Core utilities
    bat
    eza
    fd
    fzf
    ripgrep
    jq
    less

    # System monitoring
    bottom    # btm command
    htop
    duf
    dust

    # Git related
    git
    git-lfs
    ghq

    # Development tools
    deno
    bun
    pnpm
    uv
    mise
    efm-langserver
    claude-code
    rtk # CLI proxy that compresses command output for LLMs (opencode plugin: home/opencode/)

    # Benchmarking
    hyperfine

    # Miscellaneous
    fastfetch
    zoxide
    unzip
    pigz
    gnuplot
    chawan
    libqalculate
    cloudflared

    # GUI applications
    arto # Markdown reader (github:arto-app/Arto)
  ];
}

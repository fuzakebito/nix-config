{ config, pkgs, inputs, ... }:

let
  # RTK token-compression plugin, generated FROM the pinned `pkgs.rtk` binary
  # (not vendored, not a separate flake input) so the plugin always matches the
  # installed rtk version and auto-updates whenever nixpkgs bumps `rtk` — zero
  # manual sync. `rtk init` writes exactly one file offline; we extract it.
  # --hook-only: plugin only, no RTK.md. Telemetry is opt-in (off) — pinned off
  # anyway for the sandboxed build.
  rtkOpencodePlugin = pkgs.runCommand "rtk-opencode-plugin" { } ''
    export HOME="$TMPDIR"
    export XDG_CONFIG_HOME="$TMPDIR/.config"
    export RTK_TELEMETRY_DISABLED=1
    ${pkgs.rtk}/bin/rtk init -g --opencode --hook-only --auto-patch
    install -Dm644 "$XDG_CONFIG_HOME/opencode/plugins/rtk.ts" "$out"
  '';

  # opencode.json is generated so the EXA API key path (a sops secret) can be
  # baked into the mcp.exa block. opencode resolves "{file:/abs/path}" at
  # runtime, so no env-injection wrapper around the opencode binary is needed
  # — exa-mcp-server gets EXA_API_KEY straight from the decrypted sops file.
  opencodeConfig = (pkgs.formats.json { }).generate "opencode.json" {
    "$schema" = "https://opencode.ai/config.json";
    plugin = [
      "oh-my-openagent@latest"
      "opencode-claude-auth@latest"
      "@tarquinen/opencode-dcp@latest"
    ];
    compaction = {
      auto = false;
    };
    lsp = {
      efm-langserver = {
        command = [ "efm-langserver" ];
        extensions = [ ".md" ];
        initialization = {
          documentFormatting = true;
          documentRangeFormatting = true;
          hover = true;
          documentSymbol = true;
          codeAction = true;
          completion = true;
        };
      };
    };
    agent = { };
    provider = {
      ollama = {
        npm = "@ai-sdk/openai-compatible";
        name = "Ollama (local)";
        options = {
          baseURL = "http://localhost:11434/v1";
        };
        models = {
          "gemma4:e4b" = {
            name = "gemma4:e4b";
          };
        };
      };
    };
    # Replaces oh-my-openagent's bundled `websearch` MCP (disabled in
    # oh-my-openagent.json). Key is read from the sops-managed file at runtime.
    mcp = {
      exa = {
        type = "local";
        command = [ "bunx" "exa-mcp-server" ];
        enabled = true;
        environment = {
          EXA_API_KEY = "{file:${config.sops.secrets.exa_api_key.path}}";
        };
      };
    };
  };
in
{
  sops = {
    age.keyFile = "${config.home.homeDirectory}/.config/sops/age/keys.txt";
    defaultSopsFile = ../../secrets.yaml;
    secrets.exa_api_key = { };
  };

  # The opencode binary itself is intentionally NOT nix-managed — run it via
  # `bunx opencode-ai@latest` (nix-pinned builds lagged upstream / caused
  # friction). home-manager owns only the ~/.config/opencode/ tree below.

  # Declarative ~/.config/opencode/ tree.
  # Intentionally NOT managed (tool-managed at runtime):
  #   - node_modules/, package.json, package-lock.json, bun.lock
  #   - oh-my-openagent.json.bak.*, oh-my-openagent.json.migrations.json
  #   - .gitignore
  # Migrations to oh-my-openagent.json must be ported by hand into the
  # vendored copy under ./files/ instead of being applied in place.
  xdg.configFile = {
    "opencode/opencode.json".source = opencodeConfig;
    "opencode/oh-my-openagent.json".source = ./files/oh-my-openagent.json;

    # DCP (dynamic-context-pruning) plugin config. Static vendored copy — no
    # secrets, no generation. JSONC (comments + trailing layout preserved
    # verbatim); DCP reads it directly from ~/.config/opencode/dcp.jsonc.
    "opencode/dcp.jsonc".source = ./files/dcp.jsonc;

    # Custom slash commands. recursive=true so opencode can drop new
    # commands alongside without colliding with the declared ones.
    "opencode/commands" = {
      source = ./files/commands;
      recursive = true;
    };

    # RTK token-compression plugin (generated above from pkgs.rtk). Single-file
    # symlink (not a dir symlink) so opencode can still load other local plugins
    # alongside it. The `rtk` binary comes from home/packages.nix; the plugin
    # shells out to it via PATH.
    "opencode/plugins/rtk.ts".source = rtkOpencodePlugin;

    # External skills, pinned via flake inputs (see flake.nix).
    # Directory-level symlinks: tool may add other skills/* entries alongside,
    # but these two trees are read-only and tracked to upstream.
    "opencode/skills/grill-me".source =
      "${inputs.mattpocock-skills}/skills/productivity/grill-me";
    "opencode/skills/humanizer".source = "${inputs.humanizer-skill}";
  };
}

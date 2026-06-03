{ config, pkgs, inputs, ... }:

let
  # opencode.json is generated so the EXA API key path (a sops secret) can be
  # baked into the mcp.exa block. opencode resolves "{file:/abs/path}" at
  # runtime, so no env-injection wrapper around the opencode binary is needed
  # — exa-mcp-server gets EXA_API_KEY straight from the decrypted sops file.
  opencodeConfig = (pkgs.formats.json { }).generate "opencode.json" {
    "$schema" = "https://opencode.ai/config.json";
    plugin = [
      "oh-my-openagent@latest"
      "opencode-claude-auth@latest"
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

    # Custom slash commands. recursive=true so opencode can drop new
    # commands alongside without colliding with the declared ones.
    "opencode/commands" = {
      source = ./files/commands;
      recursive = true;
    };

    # External skills, pinned via flake inputs (see flake.nix).
    # Directory-level symlinks: tool may add other skills/* entries alongside,
    # but these two trees are read-only and tracked to upstream.
    "opencode/skills/grill-me".source =
      "${inputs.mattpocock-skills}/skills/productivity/grill-me";
    "opencode/skills/humanizer".source = "${inputs.humanizer-skill}";
  };
}

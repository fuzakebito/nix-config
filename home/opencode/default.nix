{ config, pkgs, inputs, ... }:

let
  opencode-wrapped = pkgs.symlinkJoin {
    name = "opencode-wrapped-${pkgs.opencode.version or "unknown"}";
    paths = [ pkgs.opencode ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/opencode \
        --run 'export EXA_API_KEY="$(${pkgs.coreutils}/bin/cat ${config.sops.secrets.exa_api_key.path})"'
    '';
    inherit (pkgs.opencode) meta;
  };
in
{
  sops = {
    age.keyFile = "${config.home.homeDirectory}/.config/sops/age/keys.txt";
    defaultSopsFile = ../../secrets.yaml;
    secrets.exa_api_key = { };
  };

  home.packages = [ opencode-wrapped ];

  # Declarative ~/.config/opencode/ tree.
  # Intentionally NOT managed (tool-managed at runtime):
  #   - node_modules/, package.json, package-lock.json, bun.lock
  #   - oh-my-openagent.json.bak.*, oh-my-openagent.json.migrations.json
  #   - .gitignore
  # Migrations to oh-my-openagent.json must be ported by hand into the
  # vendored copy under ./files/ instead of being applied in place.
  xdg.configFile = {
    "opencode/opencode.json".source = ./files/opencode.json;
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

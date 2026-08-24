{ config, lib, pkgs, ... }:

let
  extensionNames = [
    "@dietrichgebert/ponytail"
    "@juicesharp/rpiv-ask-user-question"
    "@juicesharp/rpiv-todo"
    "@narumitw/pi-btw"
    "@narumitw/pi-lsp"
    "@narumitw/pi-statusline"
    "@victor-software-house/pi-curated-themes"
    "context-mode"
    "pi-claude-auth"
    "pi-subagents"
    "pi-web-access"
  ];

  extensionSet = pkgs.buildNpmPackage {
    pname = "pi-extension-set";
    version = "0";
    src = ./npm;
    npmDepsHash = lib.strings.trim (builtins.readFile ./npm/npm-deps-hash);
    npmFlags = [ "--legacy-peer-deps" ];
    dontNpmBuild = true;
  };

  extensionRoot = "${extensionSet}/lib/node_modules/pi-extension-set/node_modules";

  settings = (pkgs.formats.json { }).generate "pi-settings.json" {
    lastChangelogVersion = pkgs.pi-coding-agent.version;
    theme = "catppuccin-mocha";
    defaultProvider = "openai-codex";
    defaultModel = "gpt-5.6-sol";
    defaultThinkingLevel = "medium";
    hideThinkingBlock = false;
    extensions = [ "${config.home.homeDirectory}/.pi/agent/plan-execute/index.ts" ];
    packages = map (name: "${extensionRoot}/${name}") extensionNames;
  };
in
{
  home.packages = [ pkgs.pi-coding-agent ];

  home.file = {
    ".pi/agent/APPEND_SYSTEM.md".source = ./files/APPEND_SYSTEM.md;
    ".pi/agent/agents" = {
      source = ./files/agents;
      recursive = true;
    };
    ".pi/agent/plan-execute" = {
      source = ./files/plan-execute;
      recursive = true;
    };
  };

  # Pi writes UI choices and internal state back to settings.json. Keep Nix as
  # the source of truth while giving Pi the writable file its settings API expects.
  home.activation.installPiSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    piAgentDir=${lib.escapeShellArg "${config.home.homeDirectory}/.pi/agent"}
    piSettingsTmp="$piAgentDir/.settings.json.home-manager.$$"

    run ${pkgs.coreutils}/bin/install -d -m 0700 "$piAgentDir"
    run ${pkgs.coreutils}/bin/install -m 0600 ${settings} "$piSettingsTmp"
    run ${pkgs.coreutils}/bin/mv -Tf "$piSettingsTmp" "$piAgentDir/settings.json"

    unset piAgentDir piSettingsTmp
  '';
}

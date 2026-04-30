{ config, pkgs, ... }:

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
    defaultSopsFile = ../secrets.yaml;
    secrets.exa_api_key = { };
  };

  home.packages = [ opencode-wrapped ];
}

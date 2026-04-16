{ config, pkgs, ... }:

{
  sops = {
    age.keyFile = "${config.home.homeDirectory}/.config/sops/age/keys.txt";
    age.generateKey = true;

    defaultSopsFile = ../secrets.yaml;

    secrets.cloudflared_token = {
      path = "%r/cloudflared_token";
      mode = "0400";
    };
  };

  systemd.user.services.cloudflared = {
    Unit = {
      Description = "Cloudflare Tunnel (remote-managed)";
      Documentation = [ "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" ];
      After = [
        "network-online.target"
        "sops-nix.service"
      ];
      Wants = [ "network-online.target" ];
      Requires = [ "sops-nix.service" ];
    };

    Service = {
      Type = "notify";
      TimeoutStartSec = 30;
      ExecStart = "${pkgs.cloudflared}/bin/cloudflared tunnel --no-autoupdate --loglevel info run --token-file %t/cloudflared_token";
      Restart = "on-failure";
      RestartSec = 5;
      StandardOutput = "journal";
      StandardError = "journal";

      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = "read-only";
    };

    Install.WantedBy = [ "default.target" ];
  };
}

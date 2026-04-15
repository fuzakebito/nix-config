{ pkgs, ... }:

{
  systemd.user.services.denops-shared-server = {
    Unit = {
      Description = "Denops shared server";
      Documentation = "https://github.com/vim-denops/denops.vim";
    };
    Service = {
      Type = "simple";
      Restart = "always";
      ExecStart = "${pkgs.deno}/bin/deno run -q --no-lock -A --unstable-kv %h/.cache/dein/.cache/init.lua/.dein/denops/@denops-private/cli.ts --hostname 127.0.0.1 --port 32123";
    };
    Install = {
      WantedBy = [ "default.target" ];
    };
  };

  systemd.user.services.xremap = {
    Unit = {
      Description = "xremap";
    };
    Service = {
      Type = "simple";
      KillMode = "process";
      # xremap is in nixpkgs (0.15.0)
      ExecStart = "${pkgs.xremap}/bin/xremap --watch %h/.config/xremap/config.yml";
      Restart = "always";
    };
    Install = {
      WantedBy = [ "default.target" ];
    };
  };
}

{ config, lib, pkgs, ... }:

{
  # GPG secret subkeys (S/A/E) + ownertrust are encrypted in secrets.yaml
  # and decrypted by sops-nix at activation, then imported into the user's
  # GnuPG keyring. The primary key (61DD68A1C8EC3BDC052DF4012CBB3D7C085182D4)
  # is offline-only (sec#); `gpg --export-secret-subkeys` ships only what
  # actually lives on this machine. Public material is folded into the same
  # armored export, so a single `gpg --import` makes a fresh keyring
  # immediately usable for signing/auth/encrypt.
  #
  # The `gpg` binary at runtime comes from the system (Arch pacman / NixOS
  # systemPackages) per the binary-vs-config split convention. pkgs.gnupg
  # is referenced from the activation script only — home-manager activation
  # has a minimal PATH, so we pin the import binary deterministically here
  # without forcing the user's interactive `gpg` to come from nixpkgs.
  sops.secrets = {
    gpg_subkeys = { };
    gpg_ownertrust = { };
  };

  # Keep passphrases cached for a full work session while still forcing a
  # re-prompt after one day at most. The SSH variants cover authentication
  # subkeys when gpg-agent is used as an ssh-agent.
  home.file.".gnupg/gpg-agent.conf".text = ''
    default-cache-ttl 28800
    max-cache-ttl 86400
    default-cache-ttl-ssh 28800
    max-cache-ttl-ssh 86400
  '';

  # In home-manager mode sops-nix decrypts secrets from a user systemd service.
  # The activation DAG node named `sops-nix` only restarts that service, so an
  # activation hook ordered after it can still race the actual secret creation.
  # ExecStartPost runs inside the one-shot service after decryption has finished.
  # `gpg --import` and `gpg --import-ownertrust` are both idempotent: re-running
  # on a populated keyring updates trust/expirations as needed and is a no-op for
  # already-known material.
  systemd.user.services.sops-nix.Service.ExecStartPost = [
    "${pkgs.gnupg}/bin/gpg --homedir ${config.home.homeDirectory}/.gnupg --batch --import ${config.sops.secrets.gpg_subkeys.path}"
    "${pkgs.gnupg}/bin/gpg --homedir ${config.home.homeDirectory}/.gnupg --import-ownertrust ${config.sops.secrets.gpg_ownertrust.path}"
  ];

  # sops-nix's own activation hook may restart the previous generation's unit
  # before reloadSystemd installs the new one. Restart it again after reload so
  # the updated service (including ExecStartPost above) runs during this switch.
  home.activation.restartSopsNixForGpg = lib.hm.dag.entryAfter [ "reloadSystemd" ] ''
    systemdStatus=$(${pkgs.systemd}/bin/systemctl --user is-system-running 2>&1 || true)

    if [[ $systemdStatus == 'running' || $systemdStatus == 'degraded' ]]; then
      run ${pkgs.systemd}/bin/systemctl restart --user sops-nix
    else
      echo "User systemd daemon not running. GPG keys will import when sops-nix.service starts."
    fi

    unset systemdStatus
  '';
}

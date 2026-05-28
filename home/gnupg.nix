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

  # `gpg --import` and `gpg --import-ownertrust` are both idempotent:
  # re-running on a populated keyring updates trust/expirations as needed
  # and is a no-op for already-known material.
  home.activation.importGpgKeys = lib.hm.dag.entryAfter [ "sops-nix" ] ''
    run ${pkgs.gnupg}/bin/gpg --batch --import "${config.sops.secrets.gpg_subkeys.path}"
    run ${pkgs.gnupg}/bin/gpg --import-ownertrust "${config.sops.secrets.gpg_ownertrust.path}"
  '';
}

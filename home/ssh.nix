{ config, ... }:

{
  # ~/.ssh/config — generated from matchBlocks below.
  # ProxyCommand uses bare `cloudflared` (PATH lookup, DECISION-1):
  # cloudflared is system-provided on both Arch (/usr/bin) and NixOS
  # (/run/current-system/sw/bin); hardcoding /usr/bin breaks NixOS.
  programs.ssh = {
    enable = true;
    # The original hand-written ~/.ssh/config carried no global options.
    # Opt out of home-manager's implicit defaults (serverAliveInterval,
    # controlMaster, forwardAgent, ...) to preserve that exact behavior
    # and silence the deprecation warning.
    enableDefaultConfig = false;
    matchBlocks = {
      "github github.com" = {
        hostname = "github.com";
        user = "git";
        identityFile = "~/.ssh/id_rsa";
      };
      "rpi rpi.n0a.org" = {
        hostname = "rpi.n0a.org";
        user = "pi";
      };
      "yoneken yoneken.fuzake.io" = {
        hostname = "yoneken.fuzake.io";
        user = "administrator";
        proxyCommand = "cloudflared access ssh --hostname %h";
      };
      "sun ssh.fuzakebito.com" = {
        hostname = "ssh.fuzakebito.com";
        user = "fuzakebito";
        proxyCommand = "cloudflared access ssh --hostname %h";
      };
    };
  };

  # Public material — small, inlined to keep the module self-contained.
  home.file.".ssh/id_rsa.pub".text = ''
    ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDa/f5WLzYFj+R4D0BLlboZB3i6BjHvfNhDr6TchGlMRboLkK2RBiBr/ek4iELT0qdBD6EMSchD5NDpoUul8FwPGPdTGav7ZPBg+MWrAtPyDqULfomDMsFE5BuAOZjF1DJoNrFAFO98qg3ELkbR3GLaJBcs3JMMuofoaKBWgZ0YIxXDiuD87hDhW+DHA1lmIP74XzlIgqWw0a/0zWmNABrkVtQK/ywpcsCAAdksPmrVANL83j0xHwyo+kY67WtyW7H4ys2/rfARXQykk+6Bc/5C8yFW7pxw7lt/ChQgWSKlhiR+fy1m59euy9df+Cd3SO41UYUmLRamjDnhrLMbs8E14pnHn3oNve5D3qpJGuEyPC854Muhj0JHTw/wdVrCCQeNr4g7PlIsg7GqQj7Nn23iA7+NuPb8GXAaP2S9yCyR0o713GBW+uSSo8KCiiDhvEJ20XVB4BUw40/jU4bSVN3oKXInl/bB5VbVIMFhSB+sF/VODbbOaS4iafiVNQL2gV8= fuzakebito@ArchNTB
  '';
  home.file.".ssh/authorized_keys".text = ''
    ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDhJHNRy81Vn0+zc3HTNvimZx15XmATpYla97ggoawHF fuzakebito@DESKTOP-7TJKP6B
  '';

  # Private key — encrypted in secrets.yaml, decrypted by sops-nix at
  # activation time directly to ~/.ssh/id_rsa with mode 0600. The shared
  # sops.age.keyFile / defaultSopsFile are set in home/opencode/default.nix;
  # both modules merge into the same sops option set.
  sops.secrets.ssh_id_rsa = {
    path = "${config.home.homeDirectory}/.ssh/id_rsa";
    mode = "0600";
  };
}

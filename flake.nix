{
  description = "Nix home-manager configuration for fuzakebito (Arch Linux / NixOS / generic Linux)";

  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
      "https://arto.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "arto.cachix.org-1:yaH0JQomRJTosIcTh2xZPKBEny41D7h6QUePYQzWYqc="
    ];
  };

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    neovim-nightly-overlay = {
      url = "github:nix-community/neovim-nightly-overlay";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    arto = {
      url = "github:arto-app/Arto";
    };
    # Upstream-pinned skill sources for ~/.config/opencode/skills/.
    # Both are plain content trees (`flake = false`); home/opencode/ symlinks them.
    humanizer-skill = {
      url = "github:blader/humanizer";
      flake = false;
    };
    mattpocock-skills = {
      url = "github:mattpocock/skills";
      flake = false;
    };
  };

  outputs =
    inputs@{
      nixpkgs,
      home-manager,
      neovim-nightly-overlay,
      sops-nix,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          neovim-nightly-overlay.overlays.default
          (import ./overlays inputs)
        ];
        config.allowUnfreePredicate =
          pkg:
          builtins.elem (nixpkgs.lib.getName pkg) [
            "claude-code"
          ];
      };
      mkHome =
        flags:
        home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          extraSpecialArgs = flags // { inherit inputs; };
          modules = [
            ./home
            sops-nix.homeManagerModules.sops
          ];
        };
    in
    {
      # Standalone home-manager configurations.
      # Hard cutover to @arch / @nixos / @linux suffix — no `.#fuzakebito` alias (DECISION-3).
      homeConfigurations."fuzakebito@arch" = mkHome {
        isArch = true;
        isNixOS = false;
      };
      homeConfigurations."fuzakebito@nixos" = mkHome {
        isArch = false;
        isNixOS = true;
      };
      homeConfigurations."fuzakebito@linux" = mkHome {
        isArch = false;
        isNixOS = false;
      };
    };
}

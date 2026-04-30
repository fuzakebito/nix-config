{
  description = "Nix home-manager configuration for fuzakebito (Arch Linux)";

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
    opencode = {
      url = "github:anomalyco/opencode";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      nixpkgs,
      home-manager,
      neovim-nightly-overlay,
      sops-nix,
      opencode,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          neovim-nightly-overlay.overlays.default
          opencode.overlays.default
          (import ./overlays inputs)
        ];
      };
      mkHome =
        flags:
        home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          extraSpecialArgs = flags;
          modules = [
            ./home
            sops-nix.homeManagerModules.sops
          ];
        };
    in
    {
      # Standalone home-manager configurations.
      # Hard cutover to @arch / @nixos suffix — no `.#fuzakebito` alias (DECISION-3).
      homeConfigurations."fuzakebito@arch" = mkHome {
        isArch = true;
        isNixOS = false;
      };
      homeConfigurations."fuzakebito@nixos" = mkHome {
        isArch = false;
        isNixOS = true;
      };
    };
}

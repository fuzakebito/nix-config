{
  description = "Nix home-manager configuration for fuzakebito (Arch Linux)";

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
      inputs.nixpkgs.follows = "nixpkgs";
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
      };
    in
    {
      # Standalone home-manager configurations
      # Future: add nixosConfigurations here for NixOS hosts
      homeConfigurations."fuzakebito" = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ./home
          sops-nix.homeManagerModules.sops
        ];
      };
    };
}

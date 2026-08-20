#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

nixpkgs=$(nix eval --raw --impure --expr '(builtins.getFlake (toString ./.)).inputs.nixpkgs.outPath')
nodejs=$(nix build --no-link --print-out-paths --impure --expr "(import $nixpkgs {}).nodejs")
prefetch_npm_deps=$(nix build --no-link --print-out-paths --impure --expr "(import $nixpkgs {}).prefetch-npm-deps")

cd home/pi/npm
"$nodejs/bin/npm" install --package-lock-only --legacy-peer-deps --ignore-scripts
"$prefetch_npm_deps/bin/prefetch-npm-deps" package-lock.json > npm-deps-hash.tmp
mv npm-deps-hash.tmp npm-deps-hash

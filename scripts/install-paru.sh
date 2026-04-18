#!/usr/bin/env bash
# Bootstrap paru (Arch AUR helper) from source.
# Usage: bash scripts/install-paru.sh
# Idempotent: skips if paru is already installed.
# Requires: Arch Linux with base-devel + git.

set -euo pipefail

if command -v paru >/dev/null 2>&1; then
  echo "paru already installed: $(paru --version | head -1)"
  echo "To reinstall, remove with 'sudo pacman -Rns paru' first."
  exit 0
fi

if [ ! -f /etc/arch-release ]; then
  echo "This script is Arch Linux only." >&2
  exit 1
fi

for cmd in git makepkg sudo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing prerequisite: $cmd" >&2
    exit 1
  fi
done

tmpdir=$(mktemp -d -t install-paru.XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

git clone https://aur.archlinux.org/paru-bin.git "$tmpdir/paru-bin"
(cd "$tmpdir/paru-bin" && makepkg -si --noconfirm)

command -v paru >/dev/null 2>&1
echo "paru installed: $(paru --version | head -1)"

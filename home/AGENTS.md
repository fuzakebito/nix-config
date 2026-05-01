# home/

All home-manager modules for `fuzakebito@arch` and `fuzakebito@nixos`. Entry point: `default.nix` (explicit import list — no auto-discovery).

## STRUCTURE

Two module shapes, pick based on size:

- **Flat** (`home/<name>.nix`) — single-file, no auxiliary data. Example: `packages.nix`, `git.nix`, `services.nix`, `ollama.nix`, `neovim.nix`, `terminals.nix`.
- **Subdir** (`home/<name>/default.nix` + `home/<name>/files/`) — when the module deploys raw config files or vendored sources. Example: `zsh/`, `sway/`, `waybar/`, `rofi/`, `paru/`, `opencode/`.

`files.nix` is the exception: flat module that deploys multiple unrelated dotfiles from the shared `home/files/` pool (tmux, bashrc, latexmkrc, mise, xremap, bin scripts).

## WHERE TO LOOK

| I want to… | File |
|---|---|
| Add a CLI package | `packages.nix` |
| Add a shell alias / env var / plugin | `zsh/default.nix` |
| Add a git alias or change signing key | `git.nix` |
| Add a systemd user service (shared, no secrets) | `services.nix` |
| Enable an upstream HM-module daemon (no service block needed) | dedicated file (see `ollama.nix` for `services.<name>.enable`) |
| Bake a sops secret path into a generated config | dedicated subdir module (see `opencode/default.nix` — `pkgs.formats.json` + `config.sops.secrets.<name>.path`) |
| Symlink a `flake = false` upstream tree into a HM dotfile path | `opencode/default.nix` (`xdg.configFile."…".source = "${inputs.<input>}"`) |
| Drop a raw dotfile into `~/.config/<foo>` | `files.nix` + place source under `home/files/` |
| Change Sway / Waybar / Rofi behavior | `sway/`, `waybar/`, `rofi/` |
| Change terminal emulator config | `terminals.nix` (configs only; binaries are system-level) |
| Anything Arch-only | Guard with `lib.mkIf isArch { … }`; see `paru/default.nix` |

## CONVENTIONS

- **Module args**: `{ config, lib, pkgs, isArch, isNixOS, ... }:`. The `...` is required — specialArgs can grow.
- **Imports**: edit `default.nix` `imports = [ … ];` by hand. No `builtins.readDir` / auto-importer, intentionally.
- **File deployment precedence**:
  1. `programs.<tool>.*` when home-manager ships a module for the tool and it covers everything you need (Git, Zsh, Rofi, Waybar, Tmux).
  2. `xdg.configFile."<tool>" = { source = ./files; recursive = true; }` for whole-tree raw copies (Sway, WezTerm, xremap, mise, nvim).
  3. `home.file.".<dotfile>".source = ./files/<dotfile>;` for single non-XDG dotfiles (`.bashrc`, `.latexmkrc`).
- **Sharing raw files**: tool-specific sources go in `home/<tool>/files/`; cross-tool / single-file sources go in `home/files/`.
- **`lib.mk*` hierarchy**: `mkIf` for platform guards, `mkForce` for permission / precedence overrides, `mkMerge` + `mkBefore` for composing generated content (see `zsh/default.nix` `initContent`).
- **Comment language**: English default. Japanese is tolerated in modules that track an upstream decision log (see `waybar/default.nix`). Don't mix within one block.

## ANTI-PATTERNS

(Root AGENTS.md covers `programs.*` vs `xdg.configFile.*` mixing and what belongs at system level. Rules specific to authoring inside `home/`:)

- **Do not** add a new top-level directory inside `home/`. Module namespace is flat by design (Q7).
- **Do not** auto-import modules (`builtins.readDir ./.`). Explicit `imports = [ … ]` only — it doubles as the module inventory.
- **Do not** use `lib.mkDefault` for anything the user will actually rely on — both hosts share this tree, there is no downstream override layer. Use direct assignment or `lib.mkForce`.
- **Do not** read secrets from plain files. All secrets flow through `sops.secrets.*`; reference the runtime path via `config.sops.secrets.<name>.path` (see `opencode/default.nix`).

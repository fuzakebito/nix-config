# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-01T06:09Z
**Commit:** 13888e2
**Branch:** main

## OVERVIEW

Standalone **home-manager** config for user `fuzakebito`, dual-target: Arch Linux (primary) + NixOS (secondary). No NixOS system config. Single arch: `x86_64-linux`. Hand-written flake (no flake-parts / flake-utils).

## STRUCTURE

```
.
├── flake.nix            # mkHome factory; only outputs are homeConfigurations
├── flake.lock
├── home/                # all home-manager modules (see home/AGENTS.md)
├── overlays/default.nix # local overlay: re-exports `arto` and `opencode` from their flake inputs
├── scripts/install-paru.sh  # bootstrap paru on a fresh Arch box (only script in this repo)
├── secrets.yaml         # sops+age encrypted; only `exa_api_key` is currently consumed
├── .sops.yaml           # single age key (fuzakebito)
└── .sisyphus/           # AI session scratch — NOT part of the config; ignore
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add / bump a flake input | `flake.nix` inputs block |
| Add a host variant | `flake.nix` outputs; call `mkHome { isArch=…; isNixOS=…; }` |
| Add user packages | `home/packages.nix` |
| Wire a new home module | Create in `home/`, add to imports in `home/default.nix` |
| Add an Arch-only module | `lib.mkIf isArch { … }` (see `home/paru/default.nix` — the only Arch-gated module) |
| Patch a pkg / add alias / re-export a flake input as a `pkgs` attribute | `overlays/default.nix` |
| Add a secret | Re-encrypt `secrets.yaml` with `sops`, then reference via `sops.secrets.<name>` in a module |
| Add a systemd user service (no secrets) | `home/services.nix` (raw `systemd.user.services.*`) |
| Add a daemon shipped as a HM module | dedicated module file (see `home/ollama.nix` for `services.<name>.enable`) |
| Add a secret-consuming wrapped binary | dedicated module (see `home/opencode/default.nix` — `symlinkJoin` + `wrapProgram` + `${config.sops.secrets.<name>.path}`) |
| Vendor an external `flake = false` content tree | `flake.nix` input with `flake = false`, then symlink in a HM module (see `home/opencode/default.nix` for `humanizer-skill` / `mattpocock-skills`) |

## CONVENTIONS

- **Platform flags, not impure checks.** `isArch` / `isNixOS` are booleans passed via `extraSpecialArgs`. Destructure them in module args; never probe `/etc/NixOS` at eval time.
- **Binary vs config split.** GUI/display/alpm-bound binaries (`sway`, `rofi` on Arch, `paru`, terminal emulators) come from the **system** (pacman or NixOS); home-manager owns only the config. Rationale is inlined as a comment in each such module.
- **System-unstable**: `nixpkgs` tracks `nixos-unstable`. `neovim` comes from `neovim-nightly-overlay`.
- **Module arg signature**: `{ ... }:` catch-all is mandatory. specialArgs (`isArch`, `isNixOS`) are injected; strict destructuring breaks on addition.
- **Decision log**: architectural calls are tagged `DECISION-N` in code comments; full rationale in `.sisyphus/plans/wm-nix-migration.md`.

## ANTI-PATTERNS (THIS PROJECT)

- **No `.#fuzakebito` alias** (DECISION-3). Always use `.#fuzakebito@arch` or `.#fuzakebito@nixos`. Hard cutover — don't re-add the bare alias.
- **Don't add display/GPU-bound binaries to `home.packages`.** Alacritty, Foot, WezTerm, Sway, Rofi (on Arch), paru → system level. If you need the binary in HM, document why.
- **Don't mix `programs.<tool>.*` with raw `xdg.configFile."<tool>/…"` for the same tool.** Pick one. Rofi is fully declarative (DECISION-2); Sway is fully raw-copy. Waybar is fully declarative.
- **Don't hardcode `/usr/lib/...` paths in configs** (DECISION-1). Rely on `PATH` so the same config works on both Arch and NixOS.
- **Don't rely on git file mode for executable bits.** Use `lib.mkForce { executable = true; }` (see `home/sway/default.nix`). Guards against `lib.cleanSourceWith` stripping perms.

## UNIQUE STYLES

- **`mkHome` factory in `flake.nix`** — one `homeManagerConfiguration` call, two outputs differing only by specialArgs flags. Add a host = one new line.
- **Overlay stack, applied globally at `pkgs` construction** (not per-host): `neovim-nightly` → `opencode` → local `./overlays`. Per-host overlay swaps are not supported; add to the local overlay.
- **sops-nix wired at the home-manager level** (`sops-nix.homeManagerModules.sops` in `flake.nix`). Age key path is `~/.config/sops/age/keys.txt`, auto-generated on first switch. All secrets live in the single top-level `secrets.yaml`.

## COMMANDS

```bash
# Apply (Arch, with rollback-safe backup)
home-manager switch --flake .#fuzakebito@arch -b backup

# Apply (NixOS)
home-manager switch --flake .#fuzakebito@nixos -b backup

# Dry-build to verify both entries evaluate
nix build .#homeConfigurations."fuzakebito@arch".activationPackage  --no-link
nix build .#homeConfigurations."fuzakebito@nixos".activationPackage --no-link

# Lint / structure check
nix flake check

# Bump inputs
nix flake update

# Bootstrap paru on a fresh Arch box (one-shot, idempotent)
bash scripts/install-paru.sh
```

No formatter, no pre-commit hooks, no CI workflows. If adding, match the existing comment style (English inline; Japanese notes retained in `home/waybar/default.nix`).

## NOTES

- `home.stateVersion = "25.11"` in `home/default.nix` — don't bump without reading the HM release notes.
- `targets.genericLinux.enable = !isNixOS` handles XDG_DATA_DIRS on Arch; don't toggle manually.
- `home/zsh/default.nix` vendors four zsh plugins via `pkgs.fetchFromGitHub` with pinned `rev`+`sha256`. Update both together or the build breaks.
- `home/services.nix` denops unit hardcodes a dein cache path (`%h/.cache/dein/.cache/init.lua/.dein/…`); tied to current neovim plugin manager choice.

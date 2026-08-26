{ config, lib, pkgs, ... }:

let
  pinentryTmuxSource = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/eth-p/pinentry-tmux/464d6a2077d8469b41692838ac2665b30a515ef4/pinentry-tmux.sh";
    hash = "sha256-PZXC7vevx711Zz3c3m5q55YGLsQE8bonQu/wwEBjoLs=";
  };

  pinentryTmux = pkgs.runCommand "pinentry-tmux" { } ''
    ${pkgs.gnused}/bin/sed \
      -e "/-s 'fg=#0066aa bg=0'/d" \
      -e "/-S 'fg=#0066ff'/d" \
      -e 's/-B \\/-b rounded \\/' \
      ${pinentryTmuxSource} > "$out"
    chmod +x "$out"
  '';

  pinentryHerdr = pkgs.writeShellApplication {
    name = "pinentry-herdr";
    runtimeInputs = [ pkgs.coreutils pkgs.herdr pkgs.pinentry-curses ];
    text = ''
      if [[ -n "''${PINENTRY_HERDR_CALLER:-}" ]]; then
        popupTty=$(tty)
        pinentryArgs=()
        while IFS= read -r -d $'\0' arg; do
          pinentryArgs+=("$arg")
        done <"$PINENTRY_HERDR_ARGS"
        exec 1>"$PINENTRY_HERDR_STDOUT" 0<"$PINENTRY_HERDR_STDIN"
        trap 'kill -USR1 "$PINENTRY_HERDR_CALLER"; exit 1' INT
        "$PINENTRY_HERDR_PROGRAM" \
          "''${pinentryArgs[@]}" \
          --ttyname="$popupTty" \
          --ttytype=xterm-256color \
          --lc-ctype="''${LC_CTYPE:-C}"
        exit $?
      fi

      caller=$$
      fifoDir=$(mktemp -d)
      stdoutFifo="$fifoDir/pinentry.stdout"
      stdinFifo="$fifoDir/pinentry.stdin"
      argsFile="$fifoDir/pinentry.args"
      mkfifo "$stdoutFifo" "$stdinFifo"
      if (( $# )); then
        printf '%s\0' "$@" >"$argsFile"
      else
        : >"$argsFile"
      fi

      cleanup() {
        exec 3>&- 2>/dev/null || true
        [[ -n "''${readerPid:-}" ]] && kill "$readerPid" 2>/dev/null || true
        [[ -n "''${watchdogPid:-}" ]] && kill "$watchdogPid" 2>/dev/null || true
        rm -rf "$fifoDir"
      }
      trap 'exit 1' USR1 ALRM
      trap 'exit 0' USR2
      trap 'exit 130' INT
      trap cleanup EXIT

      if ! herdr plugin pane open \
        --plugin local.pinentry \
        --entrypoint pinentry \
        --placement popup \
        --width 78 \
        --height 18 \
        --env "PINENTRY_HERDR_CALLER=$caller" \
        --env "PINENTRY_HERDR_STDIN=$stdinFifo" \
        --env "PINENTRY_HERDR_STDOUT=$stdoutFifo" \
        --env "PINENTRY_HERDR_ARGS=$argsFile" \
        --env "PINENTRY_HERDR_PROGRAM=$PINENTRY_HERDR_PROGRAM" \
        --focus >/dev/null 2>&1
      then
        trap - EXIT INT USR1 USR2 ALRM
        rm -rf "$fifoDir"
        exec "$PINENTRY_HERDR_PROGRAM" "$@"
      fi

      (
        sleep 10
        kill -ALRM "$caller" 2>/dev/null || true
      ) &
      watchdogPid=$!

      (
        cat <"$stdoutFifo" || true
        kill -USR2 "$caller" 2>/dev/null || true
      ) &
      readerPid=$!

      exec 3>"$stdinFifo"
      kill "$watchdogPid" 2>/dev/null || true
      wait "$watchdogPid" 2>/dev/null || true
      unset watchdogPid

      while IFS= read -r line; do
        case "$line" in
          "OPTION ttyname="*) printf 'OK\n' ;;
          "GETINFO flavor"*) printf 'D pinentry-herdr\nOK\n' ;;
          *) printf '%s\n' "$line" >&3 ;;
        esac
      done

      exec 3>&-
      wait "$readerPid" || true
    '';
  };

  pinentryHerdrPlugin = pkgs.writeText "herdr-pinentry-plugin.toml" ''
    id = "local.pinentry"
    name = "Pinentry"
    version = "0.1.0"
    min_herdr_version = "0.7.4"
    platforms = ["linux"]

    [[panes]]
    id = "pinentry"
    title = "GPG Pinentry"
    placement = "popup"
    width = 78
    height = 18
    command = ["${pinentryHerdr}/bin/pinentry-herdr"]
  '';

  pinentryAuto = pkgs.writeShellScript "pinentry-auto" ''
    case "''${PINENTRY_USER_DATA:-}" in
      fuzakebito:herdr) mode=herdr ;;
      fuzakebito:tmux) mode=tmux ;;
      fuzakebito:gui) mode=gui ;;
      fuzakebito:tty) mode=tty ;;
      *)
        if [[ -n "''${HERDR_ENV:-}" ]]; then
          mode=herdr
        elif [[ -n "''${TMUX:-}" ]]; then
          mode=tmux
        elif [[ -n "''${DISPLAY:-}''${WAYLAND_DISPLAY:-}" ]]; then
          mode=gui
        else
          mode=tty
        fi
        ;;
    esac

    if [[ $mode == herdr ]]; then
      export PINENTRY_HERDR_PROGRAM=${pkgs.pinentry-curses}/bin/pinentry-curses
      exec ${pinentryHerdr}/bin/pinentry-herdr "$@"
    fi

    if [[ $mode == tmux ]]; then
      export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep pkgs.gnused pkgs.procps pkgs.tmux pkgs.which ]}:$PATH

      if [[ -z "''${TMUX:-}" ]]; then
        uid=$(${pkgs.coreutils}/bin/id -u)
        socket="''${XDG_RUNTIME_DIR:-/run/user/$uid}/tmux-$uid/default"
        serverPid=$(${pkgs.tmux}/bin/tmux -S "$socket" display-message -p '#{pid}' 2>/dev/null || true)
        [[ -n "$serverPid" ]] && export TMUX="$socket,$serverPid,0"
      fi

      export PINENTRY_TMUX_PROGRAM=${pkgs.pinentry-curses}/bin/pinentry-curses
      exec ${config.home.homeDirectory}/.local/bin/pinentry-tmux "$@"
    fi

    if [[ $mode == gui && -n "''${DISPLAY:-}''${WAYLAND_DISPLAY:-}" ]]; then
      exec ${pkgs.pinentry-gnome3}/bin/pinentry-gnome3 "$@"
    fi

    exec ${pkgs.pinentry-curses}/bin/pinentry-curses "$@"
  '';
in
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
  home.file = {
    ".local/bin/pinentry-tmux" = {
      source = pinentryTmux;
      executable = true;
    };

    ".local/bin/pinentry-auto" = {
      source = pinentryAuto;
      executable = true;
    };

    ".gnupg/gpg-agent.conf".text = ''
      pinentry-program ${config.home.homeDirectory}/.local/bin/pinentry-auto
      default-cache-ttl 28800
      max-cache-ttl 86400
      default-cache-ttl-ssh 28800
      max-cache-ttl-ssh 86400
    '';
  };

  # Herdr persists linked plugins in its session registry. Linking is idempotent
  # and also works while the server is offline, so every generation points at
  # the current Nix store path for the popup command.
  home.activation.linkPinentryHerdr = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run ${pkgs.herdr}/bin/herdr plugin link ${pinentryHerdrPlugin} --enabled
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

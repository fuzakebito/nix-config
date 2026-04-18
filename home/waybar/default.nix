{ ... }:

{
  # Full declarative (W3a): 155 行 JSONC を nix attrset に翻訳。JSONC コメントは捨象。
  # W2b: custom/media と custom/waybar-mpris は元 dotfiles で未定義なので modules-left から削除。
  # W1b: systemd.enable = true で waybar.service 自動起動、sway の exec_always waybar は T4 で削除。
  programs.waybar = {
    enable = true;
    systemd.enable = true;
    style = ./files/style.css;

    settings = [{
      # メインバー (単一出力、sway-session.target 連動)
      # layer / position / height は dotfiles 側でコメントアウトされていたので未指定 (waybar default)

      modules-left = [
        "sway/workspaces"
        "sway/mode"
        "sway/window"
        # "custom/media" — 元 dotfiles で exec 未定義 (W2b 削除)
        # "custom/waybar-mpris" — 同上 (W2b 削除)
      ];

      modules-right = [
        "idle_inhibitor"
        "pulseaudio"
        "network"
        "cpu"
        "memory"
        "temperature"
        "backlight"
        "clock"
        "battery"
        "tray"
      ];

      "sway/workspaces" = {
        disable-scroll = true;
        format = " {name} ";
      };
      "sway/window" = {
        icon = false;
      };
      "sway/mode" = {
        format = "<span style=\"italic\">{}</span>";
      };
      "mpd" = {
        format = "{stateIcon} {consumeIcon}{randomIcon}{repeatIcon}{singleIcon}{artist} - {album} - {title} ({elapsedTime:%M:%S}/{totalTime:%M:%S}) ⸨{songPosition}|{queueLength}⸩ ";
        format-disconnected = "Disconnected ";
        format-stopped = "{consumeIcon}{randomIcon}{repeatIcon}{singleIcon}Stopped ";
        unknown-tag = "N/A";
        interval = 2;
        consume-icons = { on = " "; };
        random-icons = {
          off = "<span color=\"#f53c3c\"></span> ";
          on = " ";
        };
        repeat-icons = { on = " "; };
        single-icons = { on = "1 "; };
        state-icons = {
          paused = "";
          playing = "";
        };
        tooltip-format = "MPD (connected)";
        tooltip-format-disconnected = "MPD (disconnected)";
      };
      idle_inhibitor = {
        format = "{icon}";
        format-icons = {
          activated = "";
          deactivated = "";
        };
      };
      tray = {
        spacing = 10;
      };
      clock = {
        interval = 1;
        format = "{:%m/%d %T}";
        tooltip-format = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
        format-alt = "{:%Y年(%EY)%b%d日(%a) %T%Z}";
      };
      cpu = {
        interval = 1;
        format = "<small>CPU:</small>{usage}%";
        tooltip = false;
      };
      memory = {
        interval = 1;
        format = "<small>Mem:</small>{}%";
        states = {
          critical = 95;
          warning = 90;
        };
      };
      temperature = {
        interval = 5;
        critical-threshold = 80;
        format = "{icon} {temperatureC}°C";
        format-icons = [ "" "" "" "" "" ];
      };
      backlight = {
        format = "{icon} {percent}%";
        format-icons = [ "󰃞" "󰃟" "󰃠" ];
      };
      battery = {
        interval = 5;
        states = {
          warning = 30;
          critical = 15;
        };
        format = "{icon} {capacity}%";
        format-alt = "{icon} {time}";
        format-charging = "󰃨 {capacity}%";
        format-plugged = " {capacity}%";
        format-icons = [ "󰂎" "󰁻" "󰁾" "󰂀" "󰁹" ];
      };
      "battery#bat2" = {
        bat = "BAT2";
      };
      network = {
        format-wifi = " {essid}";
        format-ethernet = "󰈀 {ifname}: {ipaddr}/{cidr}";
        format-linked = "󰈀 {ifname} (No IP)";
        format-disconnected = "⚠ offline";
        format-alt = "{ifname}: {ipaddr}/{cidr} ({signalStrength}%)";
      };
      pulseaudio = {
        format = "{icon} {volume}% {format_source}";
        format-bluetooth = "{icon} {volume}% {format_source}";
        format-bluetooth-muted = "󰝟 {icon} {format_source}";
        format-muted = "󰝟 {format_source}";
        format-source = " {volume}%";
        format-source-muted = "";
        format-icons = {
          headphone = "";
          hands-free = "󰋎";
          headset = "󰋎";
          phone = "";
          portable = "";
          car = "";
          default = [ "" "" "" ];
        };
        on-click = "pavucontrol";
      };
    }];
  };
}

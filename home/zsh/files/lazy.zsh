function mcd() {
  mkdir -p $1
  cd $1
}
function zle-cd() {
  echo -e "\033[1A"
  local dir=$(zoxide query -l | fzf --height=11 --layout=reverse --no-sort --scheme=path --info=hidden --color='border:8' --prompt="cd ❯ " --preview='eza -a --color=always --group-directories-first --icons --git {}' --preview-window=down:3,border-top)
  if [ -z "$dir" ];then
    zle reset-prompt
    return 0
  fi
  BUFFER="cd $dir"
  zle reset-prompt
  zle accept-line
}
zle -N zle-cd
bindkey '^j' zle-cd
function fzf-geometry() {
  swaytree=$(swaymsg -t get_tree)
  selected_id=$(echo "$swaytree" \
    | jq -r '
    [.. | select(.visible? == true)],
    [.. | select(.type? == "output" and .active? == true)],
    [.. | select(.type? == "root")]
    | .[] | [.id, .name] | @tsv' \
    | fzf --delimiter='\t' --with-nth=2 --height=~100% --layout=reverse | cut -f1)
  if [[ -z "$selected_id" ]]; then
      return
  fi
  echo $(echo "$swaytree" | jq --arg id "$selected_id" '.. | select(.id? == ($id | tonumber)) | .rect | "\(.x),\(.y) \(.width)x\(.height)"' -r)
}
function cache_eval {
  mkdir -p $HOME/.cache/zsh
  local cache="$HOME/.cache/zsh/$(echo $1 | tr ' ' '_').zsh"
  if [[ ! -s "$cache" ]]; then
    eval $1 > $cache
  fi
  source "$cache"
}
function stderr_window() {
  local cmd="$@"
  local pipe_name="/tmp/tmux_tty_$$"

  [ -z "$cmd" ] && { echo "Usage: stderr_window \"command\"" >&2; return 1; }
  [ -z "$TMUX" ] && { echo "stderr_window can only be used within a tmux window." >&2; return 1; }

  if [ -z "$_stderr_window_tty" ]; then
    mkfifo "$pipe_name" || return 1
    tmux split-window -v -d "tty > '$pipe_name'; printf '\033]2;error_output\033\\'; cat"
    _stderr_window_tty=$(cat "$pipe_name")
    rm -f "$pipe_name"
  fi

  [ -z "$_stderr_window_tty" ] && return 1

  local cols=$(tmux list-panes -F '#{pane_width} #{pane_title}' | grep error_output | awk '{print $1}')

  if eval "$cmd" 2> >(tee "$_stderr_window_tty" >&2); then
    echo -n '\033[90m' >$_stderr_window_tty
    yes ─ | head -n $cols | tr -d '\n' >$_stderr_window_tty
    echo -n '\033[0m' >$_stderr_window_tty
  else
    local exit_code=$?
    echo "Command failed (exit code: $exit_code)." >"$_stderr_window_tty"
    echo -n '\033[90m' >$_stderr_window_tty
    yes ─ | head -n $cols | tr -d '\n' >$_stderr_window_tty
    echo -n '\033[0m' >$_stderr_window_tty
    return $exit_code
  fi
}
function file-prompt() {
  for file in "$@"; do
    if [ ! -r "${file}" ]; then
      echo "Error: '${file}' cannot be read. Skipping." >&2
      continue
    fi

    echo "<file=\"${file}\">"
    cat "${file}"
    echo "</file>"
  done
}
function wmd() {
  # 引数が不足している場合は使用法を表示
  if [ $# -lt 1 ]; then
    echo "Usage: wmd URL [output_file]"
    return 1
  fi

  local url="$1"
  local outfile

  if [ $# -ge 2 ]; then
    # 第二引数で出力ファイル名が指定された場合はそれを使用
    outfile="$2"
  else
    # URL の最後の部分からファイル名を自動生成
    outfile=$(basename "$url")
    # クエリパラメータがあれば除去
    outfile="${outfile%%\?*}"
    # basename が空の場合は、たとえば末尾が "/" のときは "index.md" にする
    if [ -z "$outfile" ]; then
      outfile="index.md"
    else
      # .html または .htm なら拡張子を .md に変換、そうでなければ .md を末尾に追加
      if [[ "$outfile" =~ \.html?$ ]]; then
        outfile="${outfile%.*}.md"
      else
        outfile="${outfile}.md"
      fi
    fi
  fi

  # curl で API を叩いて、結果を出力ファイルに保存
  curl "https://r.jina.ai/$url" -H 'x-engine: readerlm-v2' -o "$outfile"
}
chpwd() {
  if [[ $(pwd) != $HOME ]]; then;
    eza -a --group-directories-first --icons --git
  fi
  git rev-parse --git-dir > /dev/null 2>&1 && git glance
}
_last_command=""
preexec() {
  _last_command="$1"
}
precmd() {
  if [[ $_last_command == nvim* ]]; then
    git rev-parse --git-dir > /dev/null 2>&1 && git glance
  fi
}
export SHELL=$(/usr/bin/env which zsh)
cache_eval "mise activate zsh"
zsh-defer cache_eval "zoxide init zsh --cmd d"

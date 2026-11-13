#!/bin/sh
# The dev box front door. Run on tezb as omerdev. Usage:
#   ./dev.sh status                 mount, free space, cache size, repos, sessions
#   ./dev.sh repos sync [name]      clone missing repos, fast-forward the rest
#   ./dev.sh session <name> [dir]   create (or reattach) a tmux session
#   ./dev.sh ls                     list tmux sessions
#   ./dev.sh attach [name]          attach to a session (most recent if omitted)
#   ./dev.sh kill <name>            kill a session
#   ./dev.sh build <dir> <cmd...>   run a heavy build under the IO guard
#   ./dev.sh cache gc               prune regenerable build caches
#   ./dev.sh agents                 what the agents are doing (and their logs)
#
# Repos and caches live on the USB NVMe SSD; secrets live on the HDD under
# ~/.config/dev. See README.md.
set -eu

MOUNT=/srv/backup-usb
DEV_ROOT=$MOUNT/dev
CODING=$DEV_ROOT/coding
CACHE=$DEV_ROOT/cache
LOGDIR=$HOME/.local/state/dev/logs
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOS_TSV=${REPOS_TSV:-$SELF_DIR/repos.tsv}
BUILD=$SELF_DIR/dev-build.sh

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

require_mount() {
    mountpoint -q "$MOUNT" || die "$MOUNT is not mounted (did the USB SSD drop?); refusing to touch $DEV_ROOT"
    [ -d "$CODING" ] || die "$CODING is missing; run provision.sh first"
}

cmd_status() {
    if mountpoint -q "$MOUNT"; then
        say "mount      $MOUNT (mounted)"
        df -h "$MOUNT" | awk 'NR==1 || NR==2 {print "           " $0}'
        [ -d "$CACHE" ] && say "cache      $(du -sh "$CACHE" 2>/dev/null | cut -f1) in $CACHE"
        [ -d "$CODING" ] && say "repos      $(find "$CODING" -mindepth 1 -maxdepth 1 -type d | wc -l) checkouts in $CODING"
    else
        say "mount      $MOUNT NOT MOUNTED — dev.sh will refuse to work"
    fi
    say "sessions"
    tmux list-sessions 2>/dev/null | sed 's/^/           /' || say "           (none)"
}

cmd_repos() {
    require_mount
    action=${1:-}; [ "$action" = sync ] || die "usage: dev.sh repos sync [name]"
    want=${2:-}
    tab=$(printf '\t')
    while IFS="$tab" read -r name remote branch linux note; do
        case "$name" in ''|\#*) continue ;; esac
        [ -z "$want" ] || [ "$want" = "$name" ] || continue
        dest=$CODING/$name
        if [ -d "$dest/.git" ]; then
            say "== $name: fetch"
            git -C "$dest" fetch --prune --quiet origin || { say "   fetch failed"; continue; }
            git -C "$dest" pull --ff-only --quiet || say "   not a fast-forward; left alone"
        else
            say "== $name: clone"
            git clone --quiet "$remote" "$dest" || { say "   clone failed"; continue; }
        fi
    done < "$REPOS_TSV"
    [ -z "$want" ] || [ -d "$CODING/$want" ] || die "no such repo in repos.tsv: $want"
}

cmd_session() {
    require_mount
    name=${1:-}; [ -n "$name" ] || die "usage: dev.sh session <name> [dir]"
    dir=${2:-$CODING}
    [ -d "$dir" ] || die "no such directory: $dir"
    if tmux has-session -t "$name" 2>/dev/null; then
        say "session $name already running"
    else
        mkdir -p "$LOGDIR"
        tmux new-session -d -s "$name" -c "$dir"
        # Keep the pane's output: this is what makes "what did it do" outlive
        # the terminal, and what dev-agents.py reports as the session log.
        tmux pipe-pane -o -t "$name:" "cat >> '$LOGDIR/$name.log'" || true
        say "started session $name in $dir (log: $LOGDIR/$name.log)"
    fi
    if [ -t 0 ]; then exec tmux attach -t "$name"; else say "attach with: tmux attach -t $name"; fi
}

cmd_ls() { tmux list-sessions 2>/dev/null || say "(no sessions)"; }

cmd_attach() {
    name=${1:-}
    if [ -z "$name" ]; then
        name=$(tmux list-sessions -F '#{session_activity} #{session_name}' 2>/dev/null | sort -rn | head -n1 | awk '{print $2}')
        [ -n "$name" ] || die "no sessions to attach to"
    fi
    exec tmux attach -t "$name"
}

cmd_kill() {
    name=${1:-}; [ -n "$name" ] || die "usage: dev.sh kill <name>"
    tmux kill-session -t "$name" && say "killed session $name"
}

cmd_build() {
    dir=${1:-}; [ -n "$dir" ] || die "usage: dev.sh build <dir> <cmd...>"
    shift
    [ "$#" -ge 1 ] || die "usage: dev.sh build <dir> <cmd...>"
    exec "$BUILD" "$dir" "$@"
}

cmd_cache() {
    require_mount
    [ "${1:-}" = gc ] || die "usage: dev.sh cache gc"
    [ -d "$CACHE" ] || { say "no cache directory yet"; return 0; }
    before=$(du -sh "$CACHE" 2>/dev/null | cut -f1)
    if command -v uv >/dev/null 2>&1; then UV_CACHE_DIR=$CACHE/uv uv cache prune >/dev/null 2>&1 || true; fi
    if command -v npm >/dev/null 2>&1; then npm cache clean --force >/dev/null 2>&1 || true; fi
    if command -v bun >/dev/null 2>&1; then bun pm cache rm >/dev/null 2>&1 || true; fi
    # Cargo keeps caches under $CARGO_HOME/registry; drop tarballs older than 30 days.
    [ -d "$CACHE/cargo/registry" ] && find "$CACHE/cargo/registry" -name '*.crate' -mtime +30 -delete 2>/dev/null || true
    after=$(du -sh "$CACHE" 2>/dev/null | cut -f1)
    say "cache gc: $before -> $after"
}

cmd_agents() {
    # The dashboard's copy under /run is written by the root timer; a human run
    # writes to the account's own state directory instead.
    exec python3 "$SELF_DIR/dev-agents.py" --out "$HOME/.local/state/dev/dev-agents.json" "$@"
}

verb=${1:-}
case "$verb" in
    status)  cmd_status ;;
    repos)   shift; cmd_repos "$@" ;;
    session) shift; cmd_session "$@" ;;
    ls)      cmd_ls ;;
    attach)  shift; cmd_attach "$@" ;;
    kill)    shift; cmd_kill "$@" ;;
    build)   shift; cmd_build "$@" ;;
    cache)   shift; cmd_cache "$@" ;;
    agents)  shift; cmd_agents "$@" ;;
    "")      die "usage: dev.sh status|repos|session|ls|attach|kill|build|cache|agents" ;;
    *)       die "unknown command: $verb" ;;
esac

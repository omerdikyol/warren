#!/bin/sh
# Idempotent provisioner for the tezb dev box. Run on tezb as omerd2 (which has
# passwordless sudo). Safe to re-run: it only creates what is missing and never
# overwrites an existing SSH key or ~/.config/dev/*.env.
#
#   ./provision.sh --dry-run     show what would change
#   ./provision.sh               apply
#   ./provision.sh --no-docker   skip the docker group (root-equivalent)
#
# Access posture, by owner request (2026-10-21): omerdev gets passwordless sudo
# and the docker group, the same as omerd2, so there is no permission friction.
# That is root-equivalent; the AGENTS.md rules about the testbed and the disks
# still apply by discipline, not by privilege. It deliberately does not restart
# sshd, Docker or the network (AGENTS.md rule 1).
set -eu

DRY=0
DOCKER=1
for arg in "$@"; do
    case "$arg" in
        --dry-run)   DRY=1 ;;
        --no-docker) DOCKER=0 ;;
        *) echo "usage: provision.sh [--dry-run] [--no-docker]" >&2; exit 2 ;;
    esac
done

USERDEV=omerdev
SSD=/srv/backup-usb
DEVROOT=$SSD/dev
HOME_DEV=/home/$USERDEV
# Everything run as omerdev uses this PATH explicitly: a non-interactive shell
# reads no rc files, and mise installs into ~/.local/bin and shims, bun globals
# (omp) into ~/.bun/bin.
DEVPATH="$HOME_DEV/.local/bin:$HOME_DEV/.local/share/mise/shims:$HOME_DEV/.opencode/bin:$HOME_DEV/.bun/bin:/usr/local/bin:/usr/bin:/bin"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

run() { if [ "$DRY" -eq 1 ]; then printf 'would: %s\n' "$*"; else "$@"; fi; }
say() { printf '%s\n' "$*"; }

# --- 1. the USB SSD must be present ------------------------------------------
# Refuse early if it is not: writing here would land on the HDD.
if [ ! -d "$SSD" ]; then
    say "FATAL: $SSD does not exist; is the USB SSD attached?"
    [ "$DRY" -eq 1 ] || exit 1
fi

# --- 2. apt baseline (before the user, so zsh exists as a login shell) --------
packages="git tmux mosh zsh sqlite3 ripgrep fd-find jq gh build-essential pkg-config libssl-dev cmake openssl ca-certificates unzip curl util-linux"
missing=""
for p in $packages; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
    say "apt: installing$missing"
    run sudo apt-get update
    # shellcheck disable=SC2086
    run sudo apt-get install -y $missing
else
    say "apt: baseline present"
fi

# --- 3. the user --------------------------------------------------------------
if id "$USERDEV" >/dev/null 2>&1; then
    say "user $USERDEV: exists"
else
    run sudo useradd --create-home --shell /usr/bin/zsh "$USERDEV"
    say "user $USERDEV: created"
fi
run sudo usermod -s /usr/bin/zsh "$USERDEV"
run sudo loginctl enable-linger "$USERDEV"

# --- 4. access: passwordless sudo, same posture as omerd2 ---------------------
SUDOERS=/etc/sudoers.d/$USERDEV
if [ "$DRY" -eq 1 ]; then
    say "would: write $SUDOERS (NOPASSWD:ALL) and validate with visudo"
else
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USERDEV" | sudo tee "$SUDOERS" >/dev/null
    sudo chmod 440 "$SUDOERS"
    sudo visudo -cf "$SUDOERS"
fi

# --- 5. groups ----------------------------------------------------------------
GROUPS="adm,systemd-journal"
[ "$DOCKER" -eq 1 ] && GROUPS="$GROUPS,docker"
say "groups: adding$GROUPS (docker is root-equivalent)"
run sudo usermod -aG "$GROUPS" "$USERDEV"

# --- 6. SSH: dirs, device keys, github known_hosts, the deploy key -------------
if [ "$DRY" -eq 1 ]; then
    say "would: create $HOME_DEV/.ssh (700), mirror omerd2's authorized_keys,"
    say "       append github.com to known_hosts, generate id_ed25519_dev if absent"
else
    sudo mkdir -p "$HOME_DEV/.ssh"
    sudo chown "$USERDEV:$USERDEV" "$HOME_DEV/.ssh"
    sudo chmod 700 "$HOME_DEV/.ssh"
    if [ -f /home/omerd2/.ssh/authorized_keys ]; then
        sudo cp -f /home/omerd2/.ssh/authorized_keys "$HOME_DEV/.ssh/authorized_keys"
        sudo chown "$USERDEV:$USERDEV" "$HOME_DEV/.ssh/authorized_keys"
        sudo chmod 600 "$HOME_DEV/.ssh/authorized_keys"
    fi
    sudo -u "$USERDEV" ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null \
        | sudo -u "$USERDEV" tee -a "$HOME_DEV/.ssh/known_hosts" >/dev/null
    [ -f "$HOME_DEV/.ssh/id_ed25519_dev" ] \
        || sudo -u "$USERDEV" ssh-keygen -q -t ed25519 -f "$HOME_DEV/.ssh/id_ed25519_dev" -N "" -C tezb-dev
    # Point git at the box's own key for GitHub. Without this, `git clone
    # git@github.com:...` in a non-interactive shell (ssh tezdev ~/dev.sh ...)
    # looks for ~/.ssh/id_ed25519, which does not exist here.
    sudo -u "$USERDEV" tee "$HOME_DEV/.ssh/config" >/dev/null <<'SSHCFG'
# GitHub over this box's own deploy key; never the Mac's key.
Host github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_dev
  IdentitiesOnly yes
SSHCFG
    sudo chmod 600 "$HOME_DEV/.ssh/config"
    sudo chown "$USERDEV:$USERDEV" "$HOME_DEV/.ssh/config"
fi

# --- 7. the USB SSD layout ----------------------------------------------------
run sudo mkdir -p "$DEVROOT/coding" "$DEVROOT/cache"
run sudo -u "$USERDEV" mkdir -p "$HOME_DEV/.local/state/dev/logs"
run sudo chown -R "$USERDEV:$USERDEV" "$DEVROOT"
if [ -L "$HOME_DEV/coding" ]; then
    say "$HOME_DEV/coding: symlink exists"
else
    run sudo -u "$USERDEV" ln -s "$DEVROOT/coding" "$HOME_DEV/coding"
    say "$HOME_DEV/coding: symlink created"
fi

# --- 8. dotfiles and the dev.sh helpers ---------------------------------------
install_user() { # src dest mode
    src=$1; dest=$2; mode=$3
    destpath=$HOME_DEV/$dest
    if [ -f "$destpath" ] && cmp -s "$src" "$destpath"; then
        say "dotfile $dest: unchanged"
        return 0
    fi
    if [ -f "$destpath" ]; then
        run sudo cp -a "$destpath" "$destpath.bak-$(date +%Y%m%d)"
    fi
    run sudo install -D -o "$USERDEV" -g "$USERDEV" -m "$mode" "$src" "$destpath"
    say "dotfile $dest: installed"
}
install_user "$SELF_DIR/dotfiles/zshrc"     ".zshrc"                 644
install_user "$SELF_DIR/dotfiles/tmux.conf" ".tmux.conf"             644
install_user "$SELF_DIR/dotfiles/gitconfig" ".gitconfig"             644
install_user "$SELF_DIR/dotfiles/mise.toml" ".config/mise/config.toml" 644
install_user "$SELF_DIR/dev.sh"             "dev.sh"                 755
install_user "$SELF_DIR/dev-build.sh"       "dev-build.sh"           755
install_user "$SELF_DIR/repos.tsv"          "repos.tsv"              644
install_user "$SELF_DIR/dev-agents.py"      "dev-agents.py"          755

# --- 9. secrets directory (values are filled in by hand) ----------------------
if [ "$DRY" -eq 1 ]; then
    say "would: create $HOME_DEV/.config/dev (700) and github.env (600) if absent"
else
    sudo mkdir -p "$HOME_DEV/.config/dev"
    sudo chown "$USERDEV:$USERDEV" "$HOME_DEV/.config/dev"
    sudo chmod 700 "$HOME_DEV/.config/dev"
    if [ ! -f "$HOME_DEV/.config/dev/github.env" ]; then
        printf 'GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_dev -o IdentitiesOnly=yes"\n' \
            | sudo -u "$USERDEV" tee "$HOME_DEV/.config/dev/github.env" >/dev/null
        sudo chmod 600 "$HOME_DEV/.config/dev/github.env"
    fi
fi

# --- 10. toolchains (mise) ----------------------------------------------------
as_dev() { run sudo -u "$USERDEV" env HOME="$HOME_DEV" PATH="$DEVPATH" sh -lc "$1"; }
if sudo -u "$USERDEV" env HOME="$HOME_DEV" PATH="$DEVPATH" sh -c 'command -v mise >/dev/null 2>&1'; then
    say "mise: present"
else
    as_dev 'curl -fsSL https://mise.run | sh'
    say "mise: installed"
fi
as_dev 'mise install --yes'

# --- 11. agent CLIs -----------------------------------------------------------
# One-liners below match each project's documented installer as of 2026-10;
# re-verify against upstream before first use (docs/runbooks.md).
have() { sudo -u "$USERDEV" env HOME="$HOME_DEV" PATH="$DEVPATH" sh -c "command -v $1 >/dev/null 2>&1"; }
for pair in \
    "claude|curl -fsSL https://claude.ai/install.sh | bash" \
    "codex|npm install -g @openai/codex" \
    "cmd|npm install -g command-code" \
    "opencode|curl -fsSL https://opencode.ai/install | bash" \
    "omp|curl -fsSL https://omp.sh/install | sh" \
    "agy|curl -fsSL https://antigravity.google/cli/install.sh | bash" \
    "freebuff|npm install -g freebuff"
do
    bin=${pair%%|*}; cmd=${pair#*|}
    if have "$bin"; then say "agent $bin: present"; else as_dev "$cmd"; say "agent $bin: installed"; fi
done

# --- 12. repositories ---------------------------------------------------------
# Needs the deploy key added to GitHub first; failures here are expected until
# then (docs/runbooks.md, "Provision the dev box").
as_dev "$HOME_DEV/dev.sh repos sync"

say ""
say "Next:"
say "  1. add the deploy key to GitHub as yourself:"
say "       ssh tezb 'sudo cat $HOME_DEV/.ssh/id_ed25519_dev.pub'"
say "  2. re-run 'ssh tezdev ~/dev.sh repos sync' once it is added"
say "  3. authorize the agent CLIs (docs/runbooks.md, 'Authorize an agent CLI')"
say "  4. fill in ~/.config/dev/*.env from dev/env.example, then chmod 600"

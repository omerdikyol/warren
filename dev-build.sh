#!/bin/sh
# Run one heavy build on the dev box under the IO guard:
#   - refuses when the USB SSD is not mounted,
#   - takes a lock so only one heavy job runs at a time on the shared device,
#   - drops to low CPU and IO priority so it cannot stall the SMR disk or the
#     scheduled jobs (AGENTS.md rules 4 and 5).
#
#   dev-build.sh <dir> <command> [args...]
set -eu

[ "$#" -ge 2 ] || { echo "usage: dev-build.sh <dir> <command> [args...]" >&2; exit 2; }
dir=$1; shift

[ -d "$dir" ] || { echo "no such directory: $dir" >&2; exit 1; }
mountpoint -q /srv/backup-usb || { echo "/srv/backup-usb is not mounted; refusing to build" >&2; exit 1; }

lock=/srv/backup-usb/dev/.build.lock
[ -d /srv/backup-usb/dev ] || { echo "/srv/backup-usb/dev is missing; run provision.sh first" >&2; exit 1; }
exec 9>"$lock"
flock -n 9 || { echo "another heavy build is running; only one at a time on this SSD" >&2; exit 1; }

# Same idiom as host/home-server-sync-deploy.sh.
renice 10 -p "$$" >/dev/null 2>&1 || true
ionice -c 2 -n 7 -p "$$" 2>/dev/null || true

hour=$(date +%H)
case "$hour" in
    00|01|02|03|04|05|06|07|08)
        echo "note: this is inside the 00:00-09:00 scheduled job window; a heavy" >&2
        echo "      build will compete with Immich, the dumps and the backups." >&2
        ;;
esac

cd "$dir"
exec "$@"

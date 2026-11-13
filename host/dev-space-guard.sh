#!/bin/sh
# Free-space guard for the USB NVMe SSD, run hourly by dev-space-guard.timer.
#
# The SSD holds ChatVault, a restic repository, and now the dev box's repos and
# caches on one ~237 GB partition. If it fills, ChatVault stops and the SSD
# restic plan fails, so this watches free space the same way temp-watch.sh
# watches temperature: notify when it drops below the limit, repeat at most
# every 6 hours while it stays low, and notify once when it recovers.
set -u
[ -r /etc/smartd-ntfy.env ] && . /etc/smartd-ntfy.env
NTFY_TOPIC="${NTFY_TOPIC:-}"
MOUNT="${DEV_SPACE_MOUNT:-/srv/backup-usb}"
MIN_FREE_GB="${DEV_MIN_FREE_GB:-15}"
STATE="${DEV_SPACE_STATE:-/var/lib/dev-space-guard.state}"
REPEAT_AFTER=21600

PREV=ok; WHEN=0
[ -r "$STATE" ] && . "$STATE"
NOW=$(date +%s)

if ! mountpoint -q "$MOUNT"; then
    # backup-watch.sh already alerts when the SSD is not mounted; do not duplicate.
    printf 'PREV=%s\nWHEN=%s\n' "$PREV" "$WHEN" > "$STATE"
    exit 0
fi

free_gb=$(df -BG --output=avail "$MOUNT" | tail -n1 | tr -dc '0-9')
MSG="$MOUNT has ${free_gb} GB free (limit ${MIN_FREE_GB} GB); dev caches live in /srv/backup-usb/dev/cache"

send() {
    [ -n "$NTFY_TOPIC" ] && curl -fsS -m 20 -H "Title: tezb dev space $1" -H "Priority: $2" \
        -H "Tags: floppy_disk" -d "$3" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1
    logger -t dev-space-guard "$1: $3"
}

if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    if [ "$PREV" = ok ] || [ $((NOW - WHEN)) -ge "$REPEAT_AFTER" ]; then
        send "low" high "$MSG"
        WHEN=$NOW
    fi
    LEVEL=bad
else
    [ "$PREV" = bad ] && send "ok again" default "$MOUNT is back above ${MIN_FREE_GB} GB free"
    LEVEL=ok; WHEN=0
fi

printf 'PREV=%s\nWHEN=%s\n' "$LEVEL" "$WHEN" > "$STATE"

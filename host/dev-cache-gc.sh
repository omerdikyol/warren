#!/bin/sh
# Weekly cache prune for the dev box, run by dev-cache-gc.timer.
#
# The build caches live on the USB NVMe SSD (/srv/backup-usb/dev/cache) and grow
# with every cargo, uv, npm and bun install. This is not a backup job and does
# not touch the repositories, so it is cheap; it exists so the dev work cannot
# quietly fill the partition that ChatVault and the SSD restic repository share.
set -u
logger -t dev-cache-gc "starting"
if ! mountpoint -q /srv/backup-usb; then
    logger -t dev-cache-gc "USB SSD not mounted; skipping (backup-watch reports that)"
    exit 0
fi
sudo -u omerdev /home/omerdev/dev.sh cache gc 2>&1 | logger -t dev-cache-gc

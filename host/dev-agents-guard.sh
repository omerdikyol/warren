#!/bin/sh
# Alert when an agent session on the dev box has gone quiet, run by
# dev-agents-guard.timer. The point is the case the owner asked about: an agent
# waiting on a permission prompt at 2 am makes no progress, and nothing says so.
#
# Reads the document dev-agents.py wrote. A session is "stale" when it has had
# no sign of life (no pane activity, no log write, no CPU time) for the
# collector's --stale window, 15 minutes by default.
#
# Same rules as the other watchdogs: notify on the way in, repeat at most every
# 6 hours while it stays stale, notify once when it moves again.
set -u
[ -r /etc/smartd-ntfy.env ] && . /etc/smartd-ntfy.env
NTFY_TOPIC="${NTFY_TOPIC:-}"
STATE=/var/lib/dev-agents-guard.state
JSON="${DEV_AGENTS_JSON:-/run/tezb-dashboard/dev-agents.json}"
REPEAT_AFTER=21600

PREV=ok; WHEN=0
[ -r "$STATE" ] && . "$STATE"
NOW=$(date +%s)

[ -r "$JSON" ] || exit 0

STALE=$(python3 - "$JSON" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    sys.exit(0)
rows = []
for s in doc.get("live", []):
    if s.get("status") != "stale":
        continue
    where = s.get("repo") or s.get("dir") or "?"
    rows.append("%s (%s in %s) quiet %dm" % (s.get("name"), s.get("agent") or "?", where,
                                             (s.get("idle_seconds") or 0) // 60))
print("; ".join(rows))
PY
)

send() {
    [ -n "$NTFY_TOPIC" ] && curl -fsS -m 20 -H "Title: tezb dev agent $1" -H "Priority: $2" \
        -H "Tags: robot" -d "$3" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1
    logger -t dev-agents-guard "$1: $3"
}

if [ -n "$STALE" ]; then
    if [ "$PREV" = ok ] || [ $((NOW - WHEN)) -ge "$REPEAT_AFTER" ]; then
        send "stale" high "$STALE. See the dashboard Dev tab or: ssh tezdev ~/dev.sh agents"
        WHEN=$NOW
    fi
    LEVEL=bad
else
    [ "$PREV" = bad ] && send "moving again" default "no dev agent session is stale any more"
    LEVEL=ok; WHEN=0
fi

printf 'PREV=%s\nWHEN=%s\n' "$LEVEL" "$WHEN" > "$STATE"

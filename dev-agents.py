#!/usr/bin/env python3
"""What the coding agents are doing on the tezb dev box.

For every tmux session on the dev account this reports: which agent CLI is in
the foreground, the repository and branch it is working in, how long it has
been running, how long since it last did anything, the tail of its output, and
where its log lives. A session that has stopped is kept for a day, so "what did
it do" outlives the pane it ran in.

Writes one JSON document (for the dashboard and for anything machine-readable)
and prints a table (for a terminal or a phone). Run every 30 s by
dev-agents.timer, or by hand with `dev.sh agents`.

    dev-agents.py [--json] [--out PATH] [--user NAME] [--stale SECONDS] [--keep SECONDS]
"""
import argparse, json, os, re, subprocess, sys, time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
# The CLI names that count as "an agent is running here". Several are npm or bun
# packages, so the kernel's comm is "node" or "bun" and only the command line
# says which agent it is; agent_name() checks both.
ENDED_KEEP = 24          # how many finished sessions stay on the board

AGENT_NAMES = {"claude", "codex", "cmd", "command-code", "opencode", "omp",
               "aider", "crush", "agy", "antigravity", "freebuff", "codebuff"}
LOG_TAIL_LINES = 8


def run(cmd, user=None, current=None, timeout=10):
    """Run a command, as another user when we are not already that user."""
    if user and current != user:
        cmd = ["sudo", "-n", "-H", "-u", user] + cmd
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def proc_stat(pid):
    """utime+stime in clock ticks and the parent pid, from /proc/<pid>/stat."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read().decode(errors="replace")
        close = data.rfind(")")
        fields = data[close + 2:].split()
        return int(fields[11]) + int(fields[12]), int(fields[1])
    except (OSError, IndexError, ValueError):
        return None, None


def process_table():
    """pid -> (ppid, cpu_ticks) for every process, read once."""
    table = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        cpu, ppid = proc_stat(int(entry))
        if ppid is not None:
            table[int(entry)] = (ppid, cpu)
    return table


def tree(root, table):
    """The process tree under root, as a set of pids."""
    children = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    seen, stack = set(), [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, ()))
    return seen


def comm(pid):
    try:
        with open(f"/proc/{pid}/comm") as f:
            return f.read().strip()
    except OSError:
        return ""


def cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return [part.decode(errors="replace") for part in f.read().split(b"\0") if part]
    except OSError:
        return []


def agent_name(pid):
    """Which agent CLI this process is, or None.

    The name comes from the kernel's comm or from any argument's basename,
    because the wrappers hide it: command-code installs as `cmd` and freebuff as
    `freebuff`, but both run under node, so comm reads "node"; omp runs under
    bun. Matching the command line catches all of them without special cases.
    """
    for candidate in [comm(pid)] + [os.path.basename(arg) for arg in cmdline(pid)]:
        candidate = candidate.strip()
        if candidate in AGENT_NAMES:
            return candidate
    return None


def is_alive(pid):
    return os.path.isdir(f"/proc/{pid}")


def etimes(pid, current=None, user=None):
    """Seconds the process has been alive, from ps; None if it is gone."""
    out = run(["ps", "-o", "etimes=", "-p", str(pid)], user=user, current=current).strip()
    try:
        return int(out)
    except ValueError:
        return None


def git_info(path, user=None, current=None):
    """Repository, branch, how many tracked files are modified, and a sample of
    which ones — the last is what makes "what is it doing" concrete."""
    if not path or not os.path.isdir(path):
        return None, None, None, None
    top = run(["git", "-C", path, "rev-parse", "--show-toplevel"], user=user, current=current).strip()
    if not top:
        return None, None, None, None
    branch = run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], user=user, current=current).strip() or None
    dirty = run(["git", "-C", path, "status", "--porcelain", "-uno"], user=user, current=current)
    rows = [ln for ln in dirty.splitlines() if ln.strip()]
    sample = rows[-1][3:].strip() if rows else None
    return os.path.basename(top), branch, len(rows), sample


def tail(path, lines=LOG_TAIL_LINES):
    """The last few lines of a log, with terminal escapes removed."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 64 * 1024))
            chunk = f.read().decode(errors="replace")
    except OSError:
        return [], None
    text = ANSI.sub("", chunk).replace("\r", "\n")
    rows = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    return rows[-lines:], os.path.getmtime(path)


# A shell prompt at the start of a line, or a line that is only a prompt.
PROMPT = re.compile(r"^[\w.@:/~-]*[%$#>]\s*")
TOOLS = ("cargo", "npm", "pnpm", "yarn", "bun", "uv", "pip", "pytest", "go test",
         "make", "docker", "git ", "ruff", "tsc", "vitest", "jest", "vite", "next ")


def summarize(lines):
    """What just happened, from the tail of the pane log.

    Returns (activity, kind, command):
      activity  the last meaningful line — usually the command's output
      kind      "command" or "output", for how the room words it
      command   the most recent command-looking line, so the room can say what
                was actually run rather than only what it printed
    """
    activity = command = None
    kind = None
    for line in reversed([l for l in (lines or []) if l.strip()]):
        text = PROMPT.sub("", line).strip()
        if not text or len(text) < 3:
            continue
        if re.fullmatch(r"[\w./-]+", text) and len(text) < 6:
            continue                       # a bare prompt or a stray word
        if activity is None:
            activity = text[:96]
            kind = "command" if any(t in text for t in TOOLS) else "output"
        if command is None and any(t in text for t in TOOLS):
            command = text[:96]
        if activity and command:
            break
    return activity, kind, command


def human(seconds):
    if seconds is None:
        return "-"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}s"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600:02d}h"


def tmux_sessions(user, current):
    fmt = "#{session_name}|#{session_created}|#{session_activity}|#{session_attached}|#{session_windows}"
    out = run(["tmux", "list-sessions", "-F", fmt], user=user, current=current)
    sessions = []
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) != 5:
            continue
        def num(v):
            try:
                return int(v)
            except ValueError:
                return 0
        sessions.append({"name": parts[0], "created": num(parts[1]), "activity": num(parts[2]),
                         "attached": parts[3], "windows": num(parts[4])})
    return sessions


def active_pane(user, current, session):
    """The first pane of the session. tmux 3.4 has no #{pane_activity} (it
    expands to nothing), so the liveness signal is the window's activity."""
    fmt = "#{pane_pid}|#{pane_current_path}|#{pane_current_command}|#{window_activity}"
    out = run(["tmux", "list-panes", "-t", session, "-F", fmt], user=user, current=current)
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) != 4:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        try:
            activity = int(parts[3])
        except ValueError:
            activity = 0
        return {"pid": pid, "path": parts[1] or "", "command": parts[2] or "", "activity": activity}
    return None


def observe(user, current, stale_after, keep, logs_dir, previous):
    """Build the session list, blending live tmux state with the previous run."""
    now = time.time()
    table = process_table()
    live = []
    for session in tmux_sessions(user, current):
        pane = active_pane(user, current, session["name"])
        if not pane:
            continue
        pids = tree(pane["pid"], table)
        cpu = sum(table[p][1] or 0 for p in pids if p in table)
        agent = None
        for pid in sorted(pids):
            agent = agent_name(pid)
            if agent:
                break
        log = os.path.join(logs_dir, session["name"] + ".log")
        lines, log_mtime = tail(log)
        signals = [pane["activity"] or session["activity"], session["activity"]]
        if log_mtime:
            signals.append(log_mtime)
        last = max(signals)
        idle = int(now - last)
        prev = previous.get(session["name"], {})
        prev_cpu = prev.get("cpu_ticks")
        if prev_cpu is not None and cpu > prev_cpu:
            status = "working"
        elif agent and idle < 120:
            status = "working"
        elif idle >= stale_after:
            status = "stale"
        elif agent:
            status = "waiting"
        else:
            status = "shell"
        repo, branch, changed, changed_sample = git_info(pane["path"], user=user, current=current)
        activity, activity_kind, last_command = summarize(lines)
        age = etimes(pane["pid"], user=user, current=current)
        live.append({
            "name": session["name"], "state": "live", "agent": agent,
            "status": status, "attached": session["attached"] != "0",
            "dir": pane["path"], "repo": repo, "branch": branch,
            "changed_files": changed, "changed_sample": changed_sample,
            "activity": activity, "activity_kind": activity_kind,
            "last_command": last_command,
            "runtime_seconds": age, "idle_seconds": idle,
            "last_activity": int(last), "log": log if os.path.exists(log) else None,
            "cpu_ticks": cpu, "last_lines": lines,
        })
    # Sessions that have gone are kept, because "what state did it leave" is
    # the useful thing when nothing is running. They are dropped by age only
    # when --keep is set; by default the newest ENDED_KEEP are remembered.
    ended = []
    live_names = {s["name"] for s in live}
    for name, prev in previous.items():
        if name in live_names:
            continue
        entry = dict(prev)
        if entry.get("state") != "ended":
            # it was live last run and is gone now: freeze what it was doing
            entry["last_status"] = entry.get("status")
            entry["last_seen"] = entry.get("last_activity") or int(now)
            entry["ended_at"] = int(now)
            entry["status"] = "ended"
            entry["state"] = "ended"
        if keep and now - entry.get("ended_at", now) > keep:
            continue
        lines, _ = tail(entry.get("log") or "")
        if lines:
            entry["last_lines"] = lines
        if entry.get("log") and not os.path.exists(entry["log"]):
            entry["log"] = None
        ended.append(entry)
    ended.sort(key=lambda s: -s.get("ended_at", 0))
    return live, ended[:ENDED_KEEP]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print JSON instead of a table")
    parser.add_argument("--out", default=os.environ.get("DEV_AGENTS_OUT", "/run/tezb-dashboard/dev-agents.json"))
    parser.add_argument("--user", default=os.environ.get("DEV_USER", "omerdev"))
    parser.add_argument("--stale", type=int, default=int(os.environ.get("DEV_AGENTS_STALE", "900")))
    parser.add_argument("--keep", type=int, default=int(os.environ.get("DEV_AGENTS_KEEP", "0")),
                        help="drop finished sessions older than this many seconds (0 keeps the newest 24)")
    parser.add_argument("--state", default=os.environ.get("DEV_AGENTS_STATE", "/var/lib/dev-agents.state.json"))
    parser.add_argument("--logs", default=os.environ.get("DEV_AGENTS_LOGS", "/home/omerdev/.local/state/dev/logs"))
    args = parser.parse_args()

    current = None
    try:
        import getpass
        current = getpass.getuser()
    except Exception:
        pass

    previous = {}
    try:
        with open(args.state) as f:
            previous = json.load(f).get("sessions", {})
    except (OSError, ValueError):
        previous = {}

    live, ended = observe(args.user, current, args.stale, args.keep, args.logs, previous)
    document = {
        "generated": int(time.time()),
        "user": args.user,
        "stale_after_seconds": args.stale,
        "live": live,
        "ended": ended,
    }

    try:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        tmp = args.out + ".tmp"
        with open(tmp, "w") as f:
            json.dump(document, f, indent=1)
        os.replace(tmp, args.out)
    except OSError as exc:
        print(f"could not write {args.out}: {exc}", file=sys.stderr)

    # Remember this run so the next one can tell working from idle, and so an
    # ended session keeps its last known shape.
    snapshot = {s["name"]: s for s in live}
    for s in ended:
        snapshot[s["name"]] = s
    try:
        os.makedirs(os.path.dirname(args.state), exist_ok=True)
        tmp = args.state + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"at": int(time.time()), "sessions": snapshot}, f, indent=1)
        os.replace(tmp, args.state)
    except OSError:
        pass

    if args.json:
        print(json.dumps(document, indent=1))
        return

    if not live and not ended:
        print("no agent sessions (start one with: dev.sh session <name>)")
        return
    header = f"{'SESSION':<16} {'AGENT':<9} {'STATUS':<8} {'RUNNING':>8} {'IDLE':>7} {'REPO':<22} {'WHAT'}"
    print(header)
    print("-" * len(header))
    for s in live + ended:
        what = (s.get("activity") or (s.get("last_lines") or ["-"])[-1])[:58]
        repo = s.get("repo") or os.path.basename(s.get("dir") or "") or "-"
        if s.get("branch"):
            repo = f"{repo}@{s['branch']}"
        print(f"{s['name']:<16} {(s.get('agent') or '-'):<9} {s['status']:<8} "
              f"{human(s.get('runtime_seconds')):>8} {human(s.get('idle_seconds')):>7} {repo[:22]:<22} {what}")


if __name__ == "__main__":
    main()

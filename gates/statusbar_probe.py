#!/usr/bin/env python3
"""Status-bar gate: does "A1 Plugged in · run in progress" tell the truth?

Compares what the Worker serves at /api/activity (what the dashboard draws) with what is actually happening
on this Mac: whether the A1 is mounted, which `hf download` is running, and how many bytes are on disk.

    python3 gates/statusbar_probe.py          # prints the JSON report; exit 0 = pass, 1 = fail, 2 = could not run
    python3 gates/statusbar_probe.py --quiet  # exit code only

The heartbeat (agent.py heartbeat, every 2 minutes) runs probe() and sends the result as presence.bar_check,
so the dashboard can say when its own numbers are wrong. Checks that don't apply right now count as passing.
"""
import json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

TRANSFER_PHASES = ("Downloading approved picks", "Updating stashed items")
LIVE_S = 90          # the dashboard treats agent posts older than this as stale
PRESENCE_S = 240     # ...and heartbeats older than this as "Mac not checking in"
BYTES_TOL = 0.05     # done_bytes may trail disk by sampling lag: 5% or 1 GB, whichever is larger
BYTES_FLOOR = 1e9


def age_s(iso, now=None):
    if not iso:
        return float("inf")
    now = now or datetime.now(timezone.utc)
    return (now - datetime.fromisoformat(str(iso).replace("Z", "+00:00"))).total_seconds()


def hf_downloads(ps_text=None):
    """Running `hf download` processes: [{pid, repo, dest}]. caffeinate wrappers are skipped."""
    if ps_text is None:
        ps_text = subprocess.run(["ps", "-eo", "pid=,args="] if sys.platform.startswith("linux") else ["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    out = []
    for line in ps_text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        cmd = parts[1]
        if cmd.startswith(("caffeinate", "systemd-inhibit")) or not re.search(r"(?:^|/)hf download ", cmd):
            continue
        m = re.search(r"\bhf download (\S+)", cmd)
        d = re.search(r"--local-dir (\S+)", cmd)
        out.append({"pid": int(parts[0]), "repo": m.group(1), "dest": d.group(1) if d else None})
    return out


def disk_bytes(path):
    # Apparent size (-A), the same measure the agent reports: exFAT's 128 KB clusters make allocated size
    # run ~20% higher on folders of small files, which would look like a wrong bar when it isn't.
    r = subprocess.run(["du", "-sk", "--apparent-size", path] if sys.platform.startswith("linux") else ["du", "-skA", path], capture_output=True, text=True)
    return int(r.stdout.split()[0]) * 1024 if r.returncode == 0 and r.stdout else None


def probe(A=None, data=None, procs=None, present=None, disk=disk_bytes, now=None):
    """Returns {ok, checks, failed, notes, at}. Every input can be injected for tests."""
    if A is None and (data is None or present is None):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
        import agent as A  # noqa: N811
    data = A.api("/api/activity") if data is None else data
    present = A.a1_present() if present is None else present
    procs = hf_downloads() if procs is None else procs
    now = now or datetime.now(timezone.utc)
    a, p = data.get("activity") or {}, data.get("presence") or {}
    logrun = p.get("logrun") or {}
    live = a.get("state") == "running" and age_s(a.get("updated_at"), now) < LIVE_S
    view = a if live else logrun                     # the same source the dashboard picks
    checks, notes = {}, []

    fresh = age_s(p.get("at"), now) < PRESENCE_S
    checks["heartbeat_fresh"] = fresh or not present
    checks["presence_matches_drive"] = (not fresh) or bool(p.get("present")) == bool(present)

    if procs:
        dl = procs[0]
        cur = view.get("current") or {}
        checks["bar_shows_running_download"] = cur.get("repo") == dl["repo"]
        checks["phase_is_transfer"] = view.get("phase") in TRANSFER_PHASES
        checks["live_posts_flowing"] = live
        if live and cur.get("done_bytes") is not None and dl.get("dest"):
            on_disk = disk(dl["dest"])
            if on_disk is not None:
                gap = abs(on_disk - cur["done_bytes"])
                checks["bytes_match_disk"] = gap <= max(BYTES_FLOOR, BYTES_TOL * on_disk)
                notes.append(f"{dl['repo']}: bar {cur['done_bytes']/1e9:.2f} GB, disk {on_disk/1e9:.2f} GB")
        if cur.get("total_bytes") and cur.get("done_bytes") is not None:
            checks["current_within_total"] = cur["done_bytes"] <= cur["total_bytes"] * 1.02
    else:
        checks["no_phantom_download"] = not (live and (a.get("current") or {}).get("action") in ("Downloading", "Updating")
                                             and age_s(a.get("updated_at"), now) > 45)

    blocked = set(p.get("needs_license") or []) | set(a.get("needs_license") or [])
    counted = [q["repo"] for q in (view.get("queue") or []) if q.get("when") == "now" and q["repo"] in blocked]
    counted += [n["repo"] for n in (data.get("next") or []) if n.get("when") == "next plug-in" and n["repo"] in blocked]
    checks["needs_license_not_counted"] = not counted
    if counted:
        notes.append("counted but can't download until the license is accepted: " + ", ".join(sorted(set(counted))))

    failed = [k for k, v in checks.items() if not v]
    return {"ok": not failed, "checks": checks, "failed": failed, "notes": notes,
            "download": procs[0]["repo"] if procs else None, "at": now.isoformat(timespec="seconds")}


if __name__ == "__main__":
    try:
        r = probe()
    except Exception as e:
        print(json.dumps({"ok": None, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(2)
    if "--quiet" not in sys.argv:
        print(json.dumps(r, indent=2))
    sys.exit(0 if r["ok"] else 1)

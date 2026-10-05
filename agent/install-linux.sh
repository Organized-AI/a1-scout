#!/bin/sh
# Install the A1 Scout agent on a Linux box (a Raspberry Pi 5 on the Tailnet, say).
#   sh agent/install-linux.sh        (run from the repo; needs ~/.nvme-stash/scout.env first)
# What's different from a Mac: no launchd, so cron runs the heartbeat every minute and the weekly check; no StartOnMount,
# so the heartbeat itself mounts the A1 when it's connected (udisksctl) and starts a run when it appears. The drive is
# found by its label (A1_LABEL, default A1) or A1_UUID_LINUX, wherever it mounts (/media/<user>/A1). Benchmarks don't
# run here: they need Apple Silicon (MLX).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="$HOME/.nvme-stash"
PY="$(command -v python3)"
[ -f "$STATE/scout.env" ] || { echo "missing $STATE/scout.env (SCOUT_URL, SCOUT_TOKEN)"; exit 1; }
mkdir -p "$STATE/venvs" "$STATE/tmp"
for t in lsblk udisksctl crontab; do command -v "$t" >/dev/null || echo "note: $t not found (sudo apt install $( [ $t = udisksctl ] && echo udisks2 || [ $t = crontab ] && echo cron || echo util-linux ))"; done
if [ ! -x "$STATE/venvs/hf/bin/hf" ]; then
  "$PY" -m venv "$STATE/venvs/hf" || { echo "python3 -m venv failed: sudo apt install python3-venv"; exit 1; }
  "$STATE/venvs/hf/bin/python" -m pip install -q --upgrade pip "huggingface_hub[hf_xet]"
fi
# cron: replace our lines, keep everything else
TAB="$(crontab -l 2>/dev/null | grep -v 'a1-scout/agent/agent.py' || true)"
{ [ -n "$TAB" ] && printf '%s\n' "$TAB"
  echo "* * * * * $PY $REPO/agent/agent.py heartbeat >/dev/null 2>&1"
  echo "5 9 * * 1 $PY $REPO/agent/agent.py weekly >> $STATE/scout-launchd.log 2>&1"; } | crontab -
echo "installed for $(hostname) with $PY (cron: heartbeat every minute, weekly Monday 09:05)"
"$STATE/venvs/hf/bin/hf" auth whoami 2>/dev/null || echo "not signed in to Hugging Face yet: run  $STATE/venvs/hf/bin/hf auth login  (gated repos need it)"

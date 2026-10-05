#!/bin/sh
# Install the A1 Scout agent on this Mac: the hf CLI in its own venv, and the three LaunchAgents with this Mac's paths.
#   sh agent/install-mac.sh          (run from the repo; needs ~/.nvme-stash/scout.env first)
# The A1 can move between Macs: every Mac with the agent checks in, and the dashboard shows which one has the drive.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="$HOME/.nvme-stash"
PY="$(ls /opt/homebrew/bin/python3 /usr/local/bin/python3 2>/dev/null | head -1 || true)"
[ -n "$PY" ] || PY=/usr/bin/python3
[ -f "$STATE/scout.env" ] || { echo "missing $STATE/scout.env (SCOUT_URL, SCOUT_TOKEN, A1_UUID)"; exit 1; }
mkdir -p "$STATE/venvs" "$STATE/tmp" "$HOME/Library/LaunchAgents"
if [ ! -x "$STATE/venvs/hf/bin/hf" ]; then
  "$PY" -m venv "$STATE/venvs/hf"
  "$STATE/venvs/hf/bin/pip" install -q --upgrade "huggingface_hub[hf_xet]"
fi
PATHS="$STATE/venvs/hf/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for name in heartbeat mount weekly; do
  src="$REPO/agent/com.organizedai.a1-scout.$name.plist"
  dst="$HOME/Library/LaunchAgents/com.organizedai.a1-scout.$name.plist"
  sed -e "s#/opt/homebrew/bin/python3#$PY#g" -e "s#/Users/supabowl/nvme-stash/a1-scout#$REPO#g" -e "s#/Users/supabowl#$HOME#g" \
      -e "s#<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>#<string>$PATHS</string>#" "$src" > "$dst"
  launchctl bootout "gui/$(id -u)/com.organizedai.a1-scout.$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
done
echo "installed for $(scutil --get ComputerName) with $PY; hf: $STATE/venvs/hf/bin/hf"
"$STATE/venvs/hf/bin/hf" auth whoami 2>/dev/null || echo "not signed in to Hugging Face yet: run  $STATE/venvs/hf/bin/hf auth login  (gated repos need it)"

#!/bin/sh
# Put the A1 Scout agent on another Mac on the Tailnet, from a Mac that already has it.
#   sh agent/push-to-mac.sh <user>@<tailscale-host>        e.g. jordaaan@jordans-mac-mini
# Copies this repo to ~/nvme-stash/a1-scout there, copies scout.env (never printed), and runs install-mac.sh there.
# Needs Tailscale SSH (or Remote Login) to that Mac. The A1 can then be plugged into either Mac.
set -eu
TARGET="${1:?usage: push-to-mac.sh user@host}"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ssh -o BatchMode=yes "$TARGET" 'mkdir -p ~/nvme-stash/a1-scout ~/.nvme-stash && chmod 700 ~/.nvme-stash'
tar -C "$REPO" --exclude node_modules --exclude __pycache__ --exclude .wrangler -cf - . | ssh -o BatchMode=yes "$TARGET" 'tar -C ~/nvme-stash/a1-scout -xf -'
if ssh -o BatchMode=yes "$TARGET" 'test -f ~/.nvme-stash/scout.env'; then
  echo "scout.env already on $TARGET, kept"
else
  ssh -o BatchMode=yes "$TARGET" 'umask 077; cat > ~/.nvme-stash/scout.env' < "$HOME/.nvme-stash/scout.env"
fi
ssh -o BatchMode=yes "$TARGET" 'sh ~/nvme-stash/a1-scout/agent/install-mac.sh'

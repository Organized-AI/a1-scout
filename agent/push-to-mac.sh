#!/bin/sh
# Put the A1 Scout agent on another machine on the Tailnet (a Mac, or Linux such as a Raspberry Pi 5), from one that has it.
#   sh agent/push-to-mac.sh <user>@<tailscale-host>        e.g. jordaaan@jordans-mac-mini, pi@pi5-dev
# Copies this repo to ~/nvme-stash/a1-scout there, copies scout.env (never printed), and runs install.sh there.
# Needs Tailscale SSH (or Remote Login) to that Mac. The A1 can then be plugged into either Mac.
set -eu
TARGET="${1:?usage: push-to-mac.sh user@host}"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ssh -o BatchMode=yes "$TARGET" 'mkdir -p ~/nvme-stash/a1-scout ~/.nvme-stash && chmod 700 ~/.nvme-stash'
COPYFILE_DISABLE=1 tar -C "$REPO" --no-xattrs --exclude node_modules --exclude __pycache__ --exclude .wrangler -cf - . | ssh -o BatchMode=yes "$TARGET" 'tar -C ~/nvme-stash/a1-scout -xf -'
if ssh -o BatchMode=yes "$TARGET" 'test -f ~/.nvme-stash/scout.env'; then
  echo "scout.env already on $TARGET, kept"
else
  ssh -o BatchMode=yes "$TARGET" 'umask 077; cat > ~/.nvme-stash/scout.env' < "$HOME/.nvme-stash/scout.env"
fi
ssh -o BatchMode=yes "$TARGET" 'sh ~/nvme-stash/a1-scout/agent/install.sh'

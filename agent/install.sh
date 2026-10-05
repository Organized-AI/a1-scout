#!/bin/sh
# Install the A1 Scout agent on this machine, macOS or Linux.
case "$(uname -s)" in
  Darwin) exec sh "$(dirname "$0")/install-mac.sh" ;;
  Linux)  exec sh "$(dirname "$0")/install-linux.sh" ;;
  *) echo "unsupported: $(uname -s)"; exit 1 ;;
esac

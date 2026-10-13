#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Checks the owner's machine before the model agent is loaded
# (docs/local/model-agent.md): Ollama listens on loopback only, the agent's
# settings and custody's credential file are readable by their owner alone,
# and the credential file holds no secret (Ollama's entry is filed as none).
# It prints what it checked, never a value, and exits 1 on the first fault.
#
# Usage: scripts/m5/model-agent-install-check.sh <settings file> <credential file>

set -eu

settings=${1:?settings file}
credentials=${2:?credential file}

fault() {
  printf 'model agent install check: %s\n' "$1" >&2
  exit 1
}

listening=$(lsof -nP -iTCP:11434 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $9 }' | sort -u)
[ -n "$listening" ] || fault 'Ollama is not listening on port 11434'
for address in $listening; do
  case $address in
    127.0.0.1:11434 | '[::1]:11434') ;;
    *) fault 'Ollama listens beyond loopback: set OLLAMA_HOST=127.0.0.1:11434' ;;
  esac
done
echo 'Ollama listens on loopback only'

for file in "$settings" "$credentials"; do
  [ -f "$file" ] || fault "a named file is missing"
  mode=$(stat -f '%Lp' "$file")
  [ "$mode" = 600 ] || fault "a file is readable by others (mode $mode, want 600)"
done
echo 'the settings and credential files are readable by their owner alone'

node -e '
  const entries = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const ok = Array.isArray(entries) && entries.length > 0 &&
    entries.every((entry) => entry.scheme === "none" && !("value" in entry) && !("header" in entry));
  process.exit(ok ? 0 : 1);
' "$credentials" || fault 'the credential file holds an entry that is not filed as none'
echo 'the credential file holds no secret'

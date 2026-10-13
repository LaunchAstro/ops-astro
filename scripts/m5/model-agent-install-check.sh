#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Before the model agent is loaded (docs/local/model-agent.md): Ollama listens
# on loopback only, the settings and credential files are readable by their
# owner alone, and the credential file holds no secret. Prints no value.
#
# Usage: scripts/m5/model-agent-install-check.sh <settings file> <credential file>

set -eu

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

for file in "${1:?settings file}" "${2:?credential file}"; do
  [ "$(stat -f '%Lp' "$file")" = 600 ] || fault 'a file is missing or readable by others'
done

node -e '
  const entries = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const none = (entry) => entry.scheme === "none" && !("value" in entry) && !("header" in entry);
  process.exit(Array.isArray(entries) && entries.length > 0 && entries.every(none) ? 0 : 1);
' "$2" || fault 'the credential file holds an entry not filed as none'
echo 'model agent install check: passed'

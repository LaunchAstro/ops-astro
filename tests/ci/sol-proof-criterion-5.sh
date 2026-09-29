#!/usr/bin/env bash
# Sol proof, criterion 5: the PR body records the complete CQ-8 size report.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
actual="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$actual" "$body"' EXIT

(
  cd "$repo_root"
  BASE_SHA=27ef6c0 HEAD_SHA=5e16ffc node scripts/pr-size.mjs > "$actual" 2>&1
) || [ "$?" -eq 1 ]
gh pr view 116 -R LaunchAstro/ops-astro --json body > "$body"

node - "$actual" "$body" <<'NODE'
const { readFileSync } = require('node:fs');
const report = readFileSync(process.argv[2], 'utf8').trimEnd().split('\n');
const { body } = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const missing = report.filter((line) => !body.includes(line));
if (missing.length > 0) {
  console.error(`Sol proof, criterion 5: the PR body records the complete CQ-8 size report: FAIL (${missing.length} of ${report.length} printed lines missing)`);
  process.exit(1);
}
console.log('Sol proof, criterion 5: the PR body records the complete CQ-8 size report: PASS');
NODE

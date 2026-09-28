#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# CQ-3: Semgrep's p/default over the two supply-chain settings files, run by CI.
# A finding is a refusal, and so is a scanner that failed, printed no report,
# reported an error or did not scan both files: a broken scan never reads clean.
set -uo pipefail
cd "$(dirname "$0")/../.."
SEMGREP_IMAGE=semgrep/semgrep:1.177.0@sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198
report="$(docker run --rm -v "$PWD:/src" -w /src "$SEMGREP_IMAGE" semgrep scan \
  --config p/default --metrics off --json pnpm-workspace.yaml renovate.json)"
STATUS=$? REPORT="$report" exec node -e '
  let r;
  try { r = JSON.parse(process.env.REPORT); } catch {}
  const scanned = r?.paths?.scanned ?? [];
  const both = ["pnpm-workspace.yaml", "renovate.json"].every((f) => scanned.includes(f));
  const clean = process.env.STATUS === "0" && both && r.errors?.length === 0 && r.results?.length === 0;
  console.log(clean ? "semgrep-settings: p/default, 0 findings on both files" :
    `semgrep-settings: refused (exit ${process.env.STATUS}, ${r?.results?.length ?? "no"} finding(s), ` +
    `${r?.errors?.length ?? "no"} error(s), both files scanned: ${both})`);
  process.exit(clean ? 0 : 1);'

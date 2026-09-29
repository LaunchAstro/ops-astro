#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

cd "$(dirname "$0")/../.."

name='current repository text does not claim a size gate or waiver'
pattern='blocks at a per-file cap|coherence waiver exists for that total|adding a size waiver leaves the old red result|per-file (review )?cap is 400|review cap is 400|coherence waivers, tier reductions|a coherence waiver, a tier reduction|size gate.s generated list'

if rg -n -i "$pattern" .github docs AI_POLICY.md migrations packages tests/acceptance tests/api tests/browser tests/commands; then
  printf 'FAIL %s\n' "$name"
  exit 1
fi

printf 'PASS %s\n' "$name"

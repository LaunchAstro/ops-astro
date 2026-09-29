// SPDX-License-Identifier: AGPL-3.0-only
// `node scripts/type-census.mjs`: the type census (MP-1-4). Stub for the red run.

const empty = { declared: [], used: {}, aboveTwenty: [], exceptions: [], violations: [] };
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(empty)}\n`);

// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm check`: every blocking gate, in the order that fails cheapest first.
//
// It runs the scripts through the same pnpm that is running this file rather
// than through whatever `pnpm` resolves to on PATH, because under corepack
// there may be no pnpm on PATH at all. That is the whole reason this is a
// script and not a chain of `&&` in package.json.
//
// The order matters. The contamination gate's self-test comes before its
// sweep, because a blind gate that has stopped working looks exactly like a
// clean repository.

import { spawnSync } from 'node:child_process';

const STEPS = [
  ['brand:check', 'product name headings'],
  ['brand:cases', 'the actual product name CLI'],
  ['typecheck', 'types'],
  ['lint', 'lint'],
  ['format:check', 'format'],
  ['test', 'tests'],
  ['gate:selftest', 'the gate proves itself'],
  ['gate:cases', 'the gate catches what it must'],
  ['gate:hooks', 'the hook handles every exit code'],
  ['commits:cases', 'commit messages and provenance'],
  ['provenance:cases', 'the actual commit message hook'],
  ['candidate:cases', 'candidate snapshots and public-content cases'],
  ['public:history:cases', 'public policy on outgoing history and metadata'],
  ['size:cases', 'the size gate and its waivers'],
  ['review:cases', 'review evidence binds to a revision'],
  ['session:cases', 'the session check reads a scope correctly'],
  ['pins', 'actions pinned and recorded'],
  ['skills:refs', 'every skill reference resolves'],
  ['merge:policy', 'nothing merges itself'],
  ['gate', 'the gate sweeps'],
  ['licences:cases', 'the licence checker refuses what it must'],
  ['licences', 'licence compatibility'],
  ['spdx:cases', 'source licence header rejection cases'],
  ['spdx', 'source licence headers'],
  ['build', 'build'],
];

const execPath = process.env['npm_execpath'];
const isScript = execPath !== undefined && /\.[cm]?js$/u.test(execPath);
const command = execPath === undefined ? 'pnpm' : isScript ? process.execPath : execPath;
const prefix = isScript && execPath !== undefined ? [execPath] : [];

const results = [];

for (const [script, label] of STEPS) {
  console.log(`\n=== ${label} (pnpm run ${script}) ===`);
  const run = spawnSync(command, [...prefix, 'run', script], { stdio: 'inherit' });
  const ok = run.status === 0;
  results.push({ script, label, ok });
  if (!ok) break;
}

console.log('\n=== summary ===');
for (const { script, label, ok } of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label} (${script})`);
}

const failed = results.find((r) => !r.ok);
if (failed) {
  console.error(`\ncheck: failed at ${failed.script}. Nothing after it ran.`);
  process.exit(1);
}
console.log('\ncheck: green.');

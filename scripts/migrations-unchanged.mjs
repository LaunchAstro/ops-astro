// SPDX-License-Identifier: AGPL-3.0-only
// Migrations already on the base branch are byte-unchanged.
//
// `migrate` refuses an applied migration whose bytes changed, but only when it
// is applied, against a database that already holds it. This catches the same
// change at review: every file under `migrations/` that exists at the merge
// base must be identical at the head. A new migration is the only way to
// change the schema. A rename or a deletion is a change.

import { execFileSync } from 'node:child_process';

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) {
  console.error('migrations-unchanged: BASE_SHA and HEAD_SHA must both be set.');
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

// The merge base, as `pr-size.mjs` measures, so a migration added on the base
// branch after this branch started is not counted against it.
const mergeBase = git(['merge-base', base, head]).trim();
const changed = git([
  'diff',
  '--name-status',
  '--no-renames',
  '-z',
  mergeBase,
  head,
  '--',
  'migrations/',
])
  .split('\0')
  .filter(Boolean);

const touched = [];
for (let at = 0; at < changed.length; at += 2) {
  if (changed[at] !== 'A') touched.push(changed[at + 1]);
}

if (touched.length > 0) {
  for (const path of touched) {
    console.error(`migrations-unchanged: ${path} is on the base branch and was changed.`);
  }
  console.error('migrations-unchanged: add a new migration instead of editing an applied one.');
  process.exit(1);
}
console.log('migrations-unchanged: every migration on the base branch is unchanged.');

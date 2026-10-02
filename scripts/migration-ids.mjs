// SPDX-License-Identifier: AGPL-3.0-only
// Every migration ID at the head is well formed and unique, and every
// migration the head adds sorts after the base's newest (Code Factory
// METHOD, Phase 2 step 7). The rule is packages/core-records/src/tenancy/migration-ids.ts.
//
// `migrate` refuses a malformed or duplicate ID, but only when it runs, and it
// applies a pending migration below its ledger's newest without a word. This
// catches both before approval and again in the merge queue, where the head is
// the group's and the base is main as it stands, so two pull requests that each
// pass against main alone are judged together. Only names are read.

import { execFileSync } from 'node:child_process';
import {
  migrationIdProblems,
  migrationPlacementProblems,
} from '../packages/core-records/src/tenancy/migration-ids.ts';

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) {
  console.error('migration-ids: BASE_SHA and HEAD_SHA must both be set.');
  process.exit(2);
}

/** The migration versions at a commit: its `migrations/*.sql`, without `.sql`. */
const versionsAt = (commit) =>
  execFileSync('git', ['ls-tree', '--name-only', '-z', commit, 'migrations/'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.sql'))
    .map((path) => path.slice('migrations/'.length, -'.sql'.length));

const atHead = versionsAt(head);
const problems = [
  ...migrationIdProblems(atHead),
  ...migrationPlacementProblems(versionsAt(base), atHead, Date.now()),
];
if (problems.length > 0) {
  for (const problem of problems) console.error(`migration-ids: ${problem}`);
  process.exit(1);
}
console.log(`migration-ids: ${atHead.length} migrations, every ID unique and in order.`);

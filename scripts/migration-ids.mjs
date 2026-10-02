// SPDX-License-Identifier: AGPL-3.0-only
// Every migration ID is well formed and unique, and every migration a change
// adds sorts after the newest one already there (Code Factory METHOD, Phase 2
// step 7). The rule is packages/core-records/src/tenancy/migration-ids.ts.
//
// `migrate` refuses a malformed or duplicate ID, but only when it runs, and it
// applies a pending migration below its ledger's newest without a word. This
// catches both before approval and again in the merge queue. It judges every
// commit on the first-parent line from the base to the head against its own
// first parent: on a pull request that is its merge with main as main now
// stands; in the queue, each entry against main plus the entries ahead of it,
// so one queued after another may not add an ID below the other's. It also
// judges the head against the base as a whole. Only names and file modes are
// read, never a file's statements.

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

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** The `migrations/*.sql` entries at a commit: version and git file mode. */
const entriesAt = (commit) =>
  git('ls-tree', '-z', commit, 'migrations/')
    .split('\0')
    .filter((line) => line.endsWith('.sql'))
    .map((line) => {
      const [meta, path] = line.split('\t');
      return {
        mode: meta.split(' ')[0],
        version: path.slice('migrations/'.length, -'.sql'.length),
      };
    });

/** What is wrong with `commit` as a change to `parent`. */
function judge(parent, commit) {
  const entries = entriesAt(commit);
  const versions = entries.map((entry) => entry.version);
  return [
    ...entries
      .filter((entry) => entry.mode !== '100644')
      .map((entry) => `${entry.version} is not a regular file (git mode ${entry.mode})`),
    ...migrationIdProblems(versions),
    ...migrationPlacementProblems(
      entriesAt(parent).map((entry) => entry.version),
      versions,
      Date.now(),
    ),
  ];
}

const links = git('rev-list', '--reverse', '--first-parent', `${base}..${head}`)
  .split('\n')
  .filter(Boolean);
// The whole range as well: the links prove the order only when the oldest one
// sits on the base, which the queue and GitHub's merge ref give but this does not assume.
const problems = new Set([
  ...judge(base, head),
  ...links.flatMap((link) => judge(`${link}^1`, link)),
]);
if (problems.size > 0) {
  for (const problem of problems) console.error(`migration-ids: ${problem}`);
  process.exit(1);
}
console.log(
  `migration-ids: ${String(entriesAt(head).length)} migrations over ${String(links.length)} ` +
    'commit(s), every ID unique and in order.',
);

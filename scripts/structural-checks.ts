// SPDX-License-Identifier: AGPL-3.0-only
// The cheap structural checks, on a head merged into its base branch as the branch stands when
// this runs (CI-STRUCT, speed audit fix 2.3).
//
// `local checks` runs all three, but a pull request's run reads the head merged with main as main
// stood at the push, and nothing re-runs it when main moves; the light set's `vitest --changed`
// selects the two test files only by import, and both read their subjects from disk. So a head
// could pass alone and fail the queue on a sum: a file at 602 lines against CQ-8's 600, a lowered
// lint baseline, a shard tipped past its balance. This judges the merged tree instead, and
// `.github/workflows/structural.yml` runs it on every pull request and again on each open pull
// request when main moves.
//
//   node scripts/structural-checks.ts merge <head> <branch>
//     Fetches <branch> from origin, checks its tip out detached and merges <head> into the
//     working tree without a commit. Prints the tip. A conflict fails, naming its files, and
//     leaves the tip checked out clean.
//   node scripts/structural-checks.ts run <base> [<check>...]
//     Runs the checks (all of them when none is named) in the working tree with BASE_SHA=<base>,
//     each to the end, prints a line per check and fails when any failed.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const VITEST = join(ROOT, 'node_modules/.bin/vitest');

/** Each check by name: the command that runs it in the working tree. */
const CHECKS: Readonly<Record<string, readonly string[]>> = {
  // Warning counts per rule against main's baseline, and the 1,000-line product file cap.
  'lint-ratchet': [process.execPath, join(ROOT, 'scripts/lint-ratchet.mjs')],
  // The runtime's function and file size caps.
  'cq-8': [VITEST, 'run', 'tests/runtime/cq-8.test.ts'],
  // Every named suite in one shard, and the heaviest shard within its share.
  'db-shards': [VITEST, 'run', 'tests/ci/db-shards.test.ts'],
};

const SHA = /^[0-9a-f]{40}$/u;
const BRANCH = /^\w[\w./-]*$/u;

const fail = (message: string): never => {
  console.error(`::error::structural: ${message}`);
  process.exit(1);
};

function git(...args: string[]): { ok: boolean; out: string } {
  const ran = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: ran.status === 0, out: `${ran.stdout}${ran.stderr}`.trim() };
}

function merge(head: string, branch: string): void {
  if (!SHA.test(head)) fail(`the head "${head}" is not a full commit id.`);
  if (!BRANCH.test(branch)) fail(`"${branch}" is not a branch name.`);
  const fetched = git('fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${branch}`);
  if (!fetched.ok) fail(`cannot fetch ${branch}: ${fetched.out}`);
  const tip = git('rev-parse', 'FETCH_HEAD').out;
  if (!git('checkout', '--quiet', '--detach', tip).ok) fail(`cannot check out ${tip}.`);
  const merged = git('merge', '--quiet', '--no-commit', '--no-ff', head);
  if (!merged.ok) {
    const files = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    git('merge', '--abort');
    fail(
      files.length > 0
        ? `${head} conflicts with ${branch} at ${tip}: ${files.join(', ')}.`
        : `cannot merge ${head} into ${branch} at ${tip}: ${merged.out}`,
    );
  }
  console.log(tip);
}

function run(base: string, names: readonly string[]): void {
  if (!SHA.test(base)) fail(`the base "${base}" is not a full commit id.`);
  const unknown = names.filter((name) => !(name in CHECKS));
  if (unknown.length > 0)
    fail(`unknown check ${unknown.join(', ')}; the checks are ${Object.keys(CHECKS).join(', ')}.`);
  const env = { ...process.env, BASE_SHA: base, GITHUB_BASE_REF: '' };
  const results = (names.length > 0 ? names : Object.keys(CHECKS)).map((name) => {
    const [command = '', ...args] = CHECKS[name] ?? [];
    console.log(`\n=== ${name} ===`);
    return { name, ok: spawnSync(command, args, { env, stdio: 'inherit' }).status === 0 };
  });
  const lines = results.map(({ name, ok }) => `${ok ? 'pass' : 'FAIL'}  ${name}`);
  console.log(`\n=== structural checks against ${base} ===\n${lines.join('\n')}`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary)
    appendFileSync(
      summary,
      `Against main at \`${base}\`:\n\n${lines.map((l) => `    ${l}`).join('\n')}\n`,
    );
  if (results.some(({ ok }) => !ok)) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'merge' && rest.length === 2) merge(rest[0] ?? '', rest[1] ?? '');
else if (command === 'run' && rest.length > 0) run(rest[0] ?? '', rest.slice(1));
else fail('use: merge <head> <branch> | run <base> [<check>...]');

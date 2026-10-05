// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm check`: every blocking gate, in the order that fails cheapest first.
//
// "Every blocking gate" was not true until 23 September. Round seven staged a
// synthetic private key, ran this, and got `check: green`: the aggregate ran
// neither Gitleaks nor the current-tree public-content command, both of which
// refuse that file. The hook and the hosted full-history job caught it, so the
// defect was a misleading aggregate rather than a way through. Both steps are
// in the list below now, and the sentence above is true again.
//
// The public-content step reads the staged tree, so it refuses while the index
// and the worktree differ. That is the right reading for a gate run before a
// commit or a push: it checks the bytes that are about to leave, not a draft.
//
// It runs the scripts through the same pnpm that is running this file rather
// than through whatever `pnpm` resolves to on PATH, because under corepack
// there may be no pnpm on PATH at all. That is the whole reason this is a
// script and not a chain of `&&` in package.json.
//
// The order matters. The contamination gate's self-test comes before its
// sweep, because a blind gate that has stopped working looks exactly like a
// clean repository.
//
// CI-SPEED, light pull requests. The `local checks` job sets CHECK_SCOPE to its
// name and scripts/ci-scope.ts decides. On a pull request the step marked
// `changed` runs only the tests the change reaches (`vitest run --changed`, from
// the pull request's base); the full run is in the merge queue, the only way
// into main. A merge group, a push, any other event and a run with no
// CHECK_SCOPE, every local run, run every step in full. A decision or a base it
// cannot read fails the check before any step runs.
//
// The build runs before the tests, on a pull request too. Tests copy the bundle
// it writes to apps/web/dist. Run last, and on a pull request not at all, it
// left them to whichever test worker built first, and a pull request's light set
// could select them without the one test that builds, so they read no bundle at
// all. The build takes seconds.
//
// Once the build passes, every step after it gets the stamp it wrote, in
// CHECK_WEB_BUILD, and no step before it gets one from outside.
// tests/ci/no-fallback-in-bundle.test.ts keeps a bundle carrying exactly that
// stamp rather than rewriting it under the other tests, and rebuilds any other
// (tests/ci/web-bundle-build.ts). A build that leaves no stamp this can read
// names nothing, so that test builds for itself.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readStamp } from '../apps/web/build-stamp.ts';
import { STEPS } from './check-steps.ts';

/** The variable the steps after the build read the bundle's stamp from. */
const BUILT = 'CHECK_WEB_BUILD';
/** Where the build writes the bundle, from the directory every step runs in. */
const BUNDLE = join('apps', 'web', 'dist');

const execPath = process.env['npm_execpath'];
const isScript = execPath !== undefined && /\.[cm]?js$/u.test(execPath);
const command = execPath === undefined ? 'pnpm' : isScript ? process.execPath : execPath;
const prefix = isScript && execPath !== undefined ? [execPath] : [];

/** A script beside this one, run by this node; its stdout, or the check fails. */
const read = (script, ...args) => {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) {
    console.error(`check: ${script} ${args.join(' ')} failed; nothing ran.`);
    process.exit(1);
  }
  return run.stdout;
};

/** On a pull request under CHECK_SCOPE, the base the light set reads the change from; else null. */
function lightBase() {
  const scope = process.env['CHECK_SCOPE'] ?? '';
  if (scope === '') return null;
  const decision = read('ci-scope.ts', scope, '--decide');
  if (decision === 'run\n') return null;
  const base = decision === 'skip\n' ? read('merge-group.mjs', 'base').trim() : '';
  if (!/^[0-9a-f]{40}$/u.test(base)) {
    console.error(`check: no light set (decision ${JSON.stringify(decision)}, base "${base}").`);
    process.exit(1);
  }
  return base;
}

const base = lightBase();
const results = [];
const env = { ...process.env };
delete env[BUILT];

for (const [script, label, light] of STEPS) {
  const changed = base !== null && light === 'changed';
  const args = changed ? ['--changed', base, '--passWithNoTests'] : [];
  const note = changed
    ? ': the full run is in the merge queue; here, the tests the change reaches'
    : '';
  console.log(`\n=== ${label} (pnpm run ${script})${note} ===`);
  const run = spawnSync(command, [...prefix, 'run', script, ...args], { stdio: 'inherit', env });
  const ok = run.status === 0;
  results.push({ script, label, ok });
  if (!ok) break;
  if (script === 'build') {
    const stamp = readStamp(BUNDLE);
    if (stamp !== undefined) env[BUILT] = stamp;
  }
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
console.log(
  base === null
    ? '\ncheck: green.'
    : '\ncheck: green, the light set. The full set runs in the merge queue.',
);

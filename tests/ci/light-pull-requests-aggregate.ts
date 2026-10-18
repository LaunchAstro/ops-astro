// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED: the required `database conformance` aggregate's own script, run under bash for every
// event, gate result, shards result, isolation shards result, scope (scripts/full-run.ts) and
// whether the pull request is a pre-check batch (#1918), for
// tests/ci/light-pull-requests-workflow.test.ts.

import { spawnSync } from 'node:child_process';
import { BATCH } from './precheck-batch.ts';

type Env = Record<string, string>;

/** A workflow expression with its `${{ }}` taken off, or the value as it was. */
export const condition = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;

const RESULTS = ['success', 'skipped', 'failure', 'cancelled'];

/** One run's event, gate result, shards results, scope and batch flag (`true` or `false`). */
type Run = {
  event: string;
  gate: string;
  shards: string;
  isolation: string;
  scope: string;
  batch: string;
};

/**
 * The aggregate's script, run under GitHub's bash with each event, gate result, shards result,
 * isolation shards result, scope and batch flag. Where the shards ran, it passes only when the
 * isolation shards, which run the isolation suites in their place, succeeded too. A skip passes on
 * a pull request whose gate passed, whose scope is not light and that is not a pre-check batch
 * (whose shards run, so their skip never passes), and on a
 * light push whose gate passed (its merge group tested the tree), and nowhere else: a failed,
 * cancelled or skipped gate skips the shards too, and that skip must not read as green; a light
 * pull request waits for the `ci-next` label.
 */
export function aggregateProblems(step: { run?: string; env?: Env } | undefined): string[] {
  if (step?.run === undefined) return ['the aggregate has no script'];
  const problems = step.run.includes('${{') ? ['the script interpolates an expression'] : [];
  const runs = ['merge_group', 'push', 'pull_request', '', 'workflow_dispatch'].flatMap((event) =>
    RESULTS.flatMap((gate) =>
      RESULTS.flatMap((shards) =>
        RESULTS.flatMap((isolation) =>
          ['full', 'light', ''].flatMap((scope) =>
            ['false', 'true'].map((batch) => ({ event, gate, shards, isolation, scope, batch })),
          ),
        ),
      ),
    ),
  );
  for (const run of runs) problems.push(...aggregateRun(step.run, step.env ?? {}, run));
  return problems;
}

/** One run of the aggregate's script on one event, gate result, shards result and isolation result. */
function aggregateRun(
  run: string,
  stepEnv: Env,
  { event, gate, shards, isolation, scope, batch }: Run,
): string[] {
  const problems: string[] = [];
  const env: Env = { PATH: process.env['PATH'] ?? '' };
  const values: Record<string, string> = {
    'needs.database-shard.result': shards,
    'needs.isolation.result': isolation,
    'needs.gate.result': gate,
    'github.event_name': event,
    'needs.gate.outputs.scope': scope,
    [BATCH]: batch,
  };
  for (const [key, value] of Object.entries(stepEnv)) {
    const known = values[String(condition(value))];
    if (known === undefined) problems.push(`env ${key}: ${String(value)} is not read here`);
    else env[key] = known;
  }
  const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    env,
    encoding: 'utf8',
  });
  const wants =
    (shards === 'success' && isolation === 'success') ||
    (shards === 'skipped' &&
      gate === 'success' &&
      ((event === 'pull_request' && scope !== 'light' && batch !== 'true') ||
        (event === 'push' && scope === 'light')));
  const got = out.status === 0 ? 'passed' : 'failed';
  if ((out.status === 0) !== wants)
    problems.push(
      `${event || 'no event'}${batch === 'true' ? ' batch' : ''} gate ${gate} shards ${shards}${isolation === 'success' ? '' : ` isolation ${isolation}`}${scope === 'full' ? '' : ` scope ${scope || 'unset'}`}: ${got}`,
    );
  return problems;
}

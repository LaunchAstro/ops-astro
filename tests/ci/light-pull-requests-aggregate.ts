// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED: the required `database conformance` aggregate's own script, run under bash for every
// event, gate result and shards result, for tests/ci/light-pull-requests-workflow.test.ts.

import { spawnSync } from 'node:child_process';

type Env = Record<string, string>;

/** A workflow expression with its `${{ }}` taken off, or the value as it was. */
export const condition = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;

const RESULTS = ['success', 'skipped', 'failure', 'cancelled'];

/**
 * The aggregate's script, run under GitHub's bash with each event, gate result and shards result.
 * A skip passes on a pull request whose gate passed, and nowhere else: a failed, cancelled or
 * skipped gate skips the shards too, and that skip must not read as green.
 */
export function aggregateProblems(step: { run?: string; env?: Env } | undefined): string[] {
  if (step?.run === undefined) return ['the aggregate has no script'];
  const problems = step.run.includes('${{') ? ['the script interpolates an expression'] : [];
  for (const event of ['merge_group', 'push', 'pull_request', '', 'workflow_dispatch'])
    for (const gate of RESULTS)
      for (const shards of RESULTS)
        problems.push(...aggregateRun(step.run, step.env ?? {}, { event, gate, shards }));
  return problems;
}

/** One run of the aggregate's script on one event, gate result and shards result. */
function aggregateRun(
  run: string,
  stepEnv: Env,
  { event, gate, shards }: { event: string; gate: string; shards: string },
): string[] {
  const problems: string[] = [];
  const env: Env = { PATH: process.env['PATH'] ?? '' };
  const values: Record<string, string> = {
    'needs.database-shard.result': shards,
    'needs.gate.result': gate,
    'github.event_name': event,
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
    shards === 'success' ||
    (shards === 'skipped' && gate === 'success' && event === 'pull_request');
  const got = out.status === 0 ? 'passed' : 'failed';
  if ((out.status === 0) !== wants)
    problems.push(`${event || 'no event'} gate ${gate} shards ${shards}: ${got}`);
  return problems;
}

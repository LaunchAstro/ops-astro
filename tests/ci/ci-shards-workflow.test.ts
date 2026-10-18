// SPDX-License-Identifier: AGPL-3.0-only
// ci.yml's side of the `local checks` and `isolation tests` shards
// (scripts/ci-shards.ts), read with a YAML parser: each is a matrix of shards
// that runs on every event it ran on whole, every command the job ran whole
// runs in one step through the wrapper for its own step, and each aggregate
// keeps the required check's name and, run under bash, passes only when every
// shard succeeded, as `database conformance` does (db-shards.test.ts).

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ci, type Job, SHARD } from './ci-shards.fixture.ts';
import { unguarded } from './open-pull-request.ts';

// Every command the two jobs ran whole, before the split, and the step that now runs it.
const LOCAL: [string, string][] = [
  [
    'container suites',
    `pnpm vitest run $(node -p "require('./tests/ci/container-suites.json').suites.join(' ')")`,
  ],
  ['browser proofs', 'pnpm vitest run tests/browser/'],
  ['semgrep settings', 'bash scripts/local/semgrep-settings.sh'],
  ['public content snapshot', 'node scripts/public-content-check.mjs --repo "$PWD"'],
  ['promotion dry run', 'node scripts/ops/promote.mjs --dry-run'],
  [
    'inbox restart',
    'bash scripts/local/restart-proof.sh --suite tests/acceptance/inbox-worker-restart.test.ts',
  ],
];
const ISOLATION: [string, string][] = [
  [
    'service stop, two addresses',
    'pnpm vitest run tests/ci/named-service-stop-proof-two-urls.test.ts',
  ],
  ['seed boundaries', 'node --test tests/review/seed-boundaries-proof.test.mjs'],
  ['seed redirect', 'node --test tests/review/seed-redirect-keeps-key-off-http.proof.test.mjs'],
];

/** Each command not in exactly one step of `job`, or not run through the wrapper for its own step. */
function commandProblems(job: Job | undefined, check: string, commands: [string, string][]) {
  const problems: string[] = [];
  const steps = job?.steps ?? [];
  for (const [step, command] of commands) {
    const holding = steps.filter((s) => s.run?.includes(command));
    // The shard arrives through env:, never expanded into the script (#1841).
    const wrapper = `node scripts/ci-shards.ts '${check}' --shard "$SHARD" --step '${step}'`;
    if (holding.length !== 1) problems.push(`${command}: in ${String(holding.length)} steps`);
    else if (!holding[0]?.run?.includes(wrapper))
      problems.push(`${command}: not through ${wrapper}`);
    else if (holding[0].env?.['SHARD'] !== SHARD)
      problems.push(`${command}: SHARD is ${String(holding[0].env?.['SHARD'])}`);
  }
  const named = steps.flatMap((s) =>
    [...(s.run ?? '').matchAll(/ci-shards\.ts '[^']+' --shard "\$SHARD" --step '([^']+)'/gu)].map(
      (m) => m[1],
    ),
  );
  if (
    named.toSorted().join('|') !==
    commands
      .map(([s]) => s)
      .toSorted()
      .join('|')
  )
    problems.push(`steps named: ${named.join(', ')}`);
  return problems;
}

/** Each way a shard job and its aggregate break the rules. */
function jobProblems(shardKey: string, name: string): string[] {
  const problems: string[] = [];
  const shards = ci.jobs[shardKey];
  if (shards?.name !== `${name} shard \${{ matrix.shard }}`)
    problems.push(`${shardKey}: named ${String(shards?.name)}`);
  // It runs on every event the job ran on whole; the aggregate never passes a skip.
  if (shards?.if !== undefined) problems.push(`${shardKey}: if: ${shards.if}`);
  if (shards?.strategy?.['fail-fast'] !== false) problems.push(`${shardKey}: fail-fast`);
  if (shards?.['continue-on-error'] !== undefined) problems.push(`${shardKey}: continue-on-error`);
  const aggregates = Object.entries(ci.jobs).filter(([, job]) => job.name === name);
  const [key = '', aggregate] = aggregates[0] ?? [];
  if (aggregates.length !== 1 || aggregate === undefined)
    return [...problems, `${name}: ${String(aggregates.length)} jobs`];
  if (unguarded(aggregate.if) !== 'always()') problems.push(`${key}: if: ${String(aggregate.if)}`);
  if (
    (aggregate.needs ?? []).toSorted().join(' ') !==
    [shardKey, 'gate', 'full', ...(shardKey === 'check' ? ['pin-tests'] : [])].toSorted().join(' ')
  )
    problems.push(`${key}: needs ${String(aggregate.needs)}`);
  if (aggregate['continue-on-error'] !== undefined || aggregate.steps?.length !== 1)
    problems.push(`${key}: one step, never continue-on-error`);
  return problems;
}

/** The shard numbers a job's matrix runs. */
const matrix = (key: string) => ci.jobs[key]?.strategy?.matrix?.shard;

/** The environment of the step that runs `step` of a shard job. */
const stepEnv = (job: string, step: string) =>
  (ci.jobs[job]?.steps ?? []).find((s) => s.run?.includes(`--step '${step}'`))?.env;

const RESULTS = ['success', 'failure', 'cancelled', 'skipped', ''];
const EVENTS = ['merge_group', 'pull_request', 'push'];
// The gate's `scope` output (scripts/full-run.ts); empty when the gate never wrote it.
const SCOPES = ['full', 'light', ''];

/** The aggregate's script under bash for one event, gate result, shards result and scope: whether it passed. */
function passes(name: string, shardKey: string, values: [string, string, string, string]): boolean {
  const step = Object.values(ci.jobs).find((job) => job.name === name)?.steps?.[0];
  const [event, gate, shards, scope] = values;
  const known: Record<string, string> = {
    [`\${{ needs.${shardKey}.result }}`]: shards,
    '${{ needs.gate.result }}': gate,
    '${{ needs.pin-tests.result }}': 'success',
    '${{ github.event_name }}': event,
    '${{ needs.gate.outputs.scope }}': scope,
  };
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  for (const [k, v] of Object.entries(step?.env ?? {})) {
    expect(known, `${k}: ${v}`).toHaveProperty([v]);
    env[k] = known[v] ?? '';
  }
  const run = step?.run ?? 'exit 1';
  return (
    spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { env }).status === 0
  );
}

describe('the workflow', () => {
  it('local checks and isolation tests each run as three shards, each with its aggregate', () => {
    expect([matrix('check'), matrix('isolation')]).toStrictEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(jobProblems('check', 'local checks')).toStrictEqual([]);
    expect(jobProblems('isolation', 'isolation tests')).toStrictEqual([]);
  });

  it('every command the jobs ran whole runs in one step, through the wrapper for its own step', () => {
    expect(commandProblems(ci.jobs['check'], 'local checks', LOCAL)).toStrictEqual([]);
    expect(commandProblems(ci.jobs['isolation'], 'isolation tests', ISOLATION)).toStrictEqual([]);
    const check = (ci.jobs['check']?.steps ?? []).filter((s) => s.run === 'pnpm check');
    expect(check.map((s) => s.env)).toStrictEqual([
      { CONTAINER_SUITES: 'apart', CHECK_SCOPE: 'local checks', CHECK_SHARD: SHARD },
    ]);
    const runner = (ci.jobs['isolation']?.steps ?? []).filter((s) =>
      s.run?.includes('scripts/db-conformance.mjs'),
    );
    expect(runner.map((s) => s.run)).toStrictEqual([
      `node scripts/ci-scope.ts 'isolation tests' -- node scripts/db-conformance.mjs --isolation --shard "$SHARD" --timing-rule "$RUNNER_TEMP/timing-rule.json"`,
    ]);
    expect(runner.map((s) => s.env?.['SHARD'])).toStrictEqual([SHARD]);
    expect(stepEnv('check', 'browser proofs')).toStrictEqual({ BROWSER_PROOFS: '1', SHARD });
    expect(stepEnv('check', 'inbox restart')).toStrictEqual({
      DOCKER: 'docker',
      L5_RUNTIME_PROOFS: '1',
      SHARD,
    });
  });
});

describe('the aggregates', () => {
  it.each([
    ['local checks', 'check'],
    ['isolation tests', 'isolation'],
  ])(
    'the %s aggregate passes when every shard succeeded, or on a light push whose gate passed',
    (name, shardKey) => {
      const run = Object.values(ci.jobs).find((job) => job.name === name)?.steps?.[0]?.run;
      expect(run).toBeDefined();
      expect(run).not.toContain('${{');
      const passed = EVENTS.flatMap((event) =>
        RESULTS.flatMap((gate) =>
          RESULTS.flatMap((shards) =>
            SCOPES.filter((scope) => passes(name, shardKey, [event, gate, shards, scope])).map(
              (scope) => `${event} ${gate} ${shards} ${scope}`,
            ),
          ),
        ),
      );
      // Every success, and the one skip a light push whose gate passed may carry.
      const wanted = EVENTS.flatMap((event) =>
        RESULTS.flatMap((gate) => SCOPES.map((scope) => `${event} ${gate} success ${scope}`)),
      ).concat('push success skipped light');
      expect(passed.toSorted()).toStrictEqual(wanted.toSorted());
    },
    120_000,
  );
});

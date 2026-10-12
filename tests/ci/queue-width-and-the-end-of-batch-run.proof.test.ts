// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-promise-executor-return, unicorn/no-array-callback-reference -- a review proof, kept as written */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ISOLATION_STEPS,
  isolationItems,
  localSteps,
  readShardPlan,
} from '../../scripts/ci-shards.ts';
import { databaseItems, planItems, readPlan, shardWeight } from '../../scripts/db-shards.ts';
import { readIsolationSuites, readNamedSuites } from '../../scripts/named-suites.ts';

it('a pull request without ci-next starts no heavy CI jobs', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'queue-hygiene-unmarked-pr-'));
  const event = join(dir, 'event.json');
  const output = join(dir, 'output');
  writeFileSync(event, JSON.stringify({ pull_request: { state: 'open', labels: [] } }));
  writeFileSync(output, '');
  try {
    const scopeStep = ci.jobs.gate.steps.find((step: { id?: string }) => step.id === 'scope');
    if (scopeStep !== undefined) {
      expect(scopeStep.run).toBe('node scripts/full-run.ts');
      const run = spawnSync(process.execPath, ['scripts/full-run.ts'], {
        env: {
          PATH: process.env['PATH'],
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
    }
    const scope = readFileSync(output, 'utf8')
      .trim()
      .replace(/^scope=/u, '');
    const runs = (key: string): boolean => {
      if (key === 'gate') return true;
      const job = ci.jobs[key];
      if (job === undefined) throw new Error(`Missing job ${key}`);
      let allowed = true;
      if (job.if !== undefined) {
        expect(job.if).toBe("needs.gate.outputs.scope != 'light'");
        allowed = scope !== 'light';
      }
      return allowed && (job.needs ?? []).every(runs);
    };
    expect(['check', 'isolation', 'parity', 'visual-drift'].filter(runs)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('the two agent suite parts collect every whole-suite case exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-hygiene-agent-collection-'));
  const config = join(dir, 'collection.config.mjs');
  writeFileSync(config, 'export default { test: { globalSetup: [], setupFiles: [] } };\n');
  const collect = (part: string): string[] => {
    const output = join(dir, `cases-${part.replace('/', '-') || 'whole'}.json`);
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        '--config',
        config,
        '--no-staticParse',
        `--json=${output}`,
        'tests/acceptance/d06-agent.test.ts',
      ],
      {
        env: {
          ...process.env,
          SUITE_PART: part,
          TMPDIR: dir,
          DATABASE_URL: 'postgres://postgres:synthetic@127.0.0.1:9/unused',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(output, 'utf8')).map((test: { name: string }) => test.name);
  };
  try {
    const whole = collect('');
    expect(whole.length).toBeGreaterThan(0);
    expect([...collect('1/2'), ...collect('2/2')].toSorted()).toEqual(whole.toSorted());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// The queue's width is bounded by runner time, not by shards at once. A group's shards end
// at different times (most database shards in 6 to 9 minutes of a 15-minute group), so a second
// group's shards take the slots the first group's free; a count of shards at once (width 2 x 42
// = 84 of 60) reads that as a jam it is not. What does bind is the work: the groups in flight
// must need no more runner time than the 60 slots give in the time one group takes, so a second
// group fills idle slots rather than stretching the first. Measured over the 10 merge groups to
// 12 October 2026: about 15 minutes a group, and each shard's minutes outside its plan's items.
const SLOTS = 60;
const GROUP_MINUTES = 15;
const OUTSIDE_ITEMS = { database: 0.8, isolation: 0.8, local: 3 };

/** The measured seconds of a list of run items, weighed as the split weighs them. */
const sum = (list: readonly string[], seconds: Readonly<Record<string, number>>): number =>
  list.reduce((total, item) => total + shardWeight(seconds)(item), 0);

/** One group's runner minutes in the three matrices: each plan's measured items, and each shard's set-up. */
function groupMinutes(scale = 1): number {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const count = (key: string): number => ci.jobs[key].strategy.matrix.shard.length;
  const shardPlan = readShardPlan('.');
  const dbPlan = readPlan('tests/db/shard-plan.json');
  const named = readNamedSuites('.');
  const runs = databaseItems(
    planItems([...named.invariant, ...named.conformance], dbPlan.parts),
    readIsolationSuites('.').invariant,
  );
  const files = Object.values(shardPlan.files).reduce((total, n) => total + n, 0);
  const seconds =
    sum(runs, dbPlan.seconds) +
    sum([...isolationItems('.'), ...ISOLATION_STEPS], shardPlan.isolation) +
    sum(localSteps(), shardPlan.steps) +
    files * shardPlan.wallPerFileSecond;
  return (
    (seconds * scale) / 60 +
    count('database-shard') * OUTSIDE_ITEMS.database +
    count('isolation') * OUTSIDE_ITEMS.isolation +
    count('check') * OUTSIDE_ITEMS.local
  );
}

it('queue width fits the runner time the 60 slots give in one group', () => {
  const policy = JSON.parse(readFileSync('.github/required-checks.json', 'utf8'));
  const width = policy.merge_queue.max_entries_to_build;
  const perGroup = groupMinutes();
  expect(
    width * perGroup,
    `${width} groups in flight need ${perGroup.toFixed(0)} runner minutes each`,
  ).toBeLessThanOrEqual(SLOTS * GROUP_MINUTES);
  // Not a bound anything passes: four times the measured work does not fit two groups.
  expect(2 * groupMinutes(4)).toBeGreaterThan(SLOTS * GROUP_MINUTES);
});

it('an unreadable empty queue with a lingering merged-group run keeps the final full run', async () => {
  const repo = 'LaunchAstro/ops-astro';
  const tree = 'a'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'queue-hygiene-final-push-'));
  const event = join(dir, 'event.json');
  const output = join(dir, 'output');
  writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' }));
  const requested: string[] = [];
  let queueReadable = true;
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requested.push(path);
    response.setHeader('content-type', 'application/json');
    if (path.includes('/git/commits/')) {
      response.end(JSON.stringify({ tree: { sha: tree } }));
    } else if (path === '/graphql') {
      response.end(
        JSON.stringify(
          queueReadable
            ? { data: { repository: { mergeQueue: { entries: { totalCount: 0 } } } } }
            : {
                data: { repository: { mergeQueue: null } },
                errors: [{ message: 'Resource not accessible by integration' }],
              },
        ),
      );
    } else if (path.includes('status=')) {
      response.end(JSON.stringify({ total_count: path.includes('status=in_progress') ? 1 : 0 }));
    } else {
      response.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 7,
              event: 'merge_group',
              path: '.github/workflows/ci.yml',
              repository: { full_name: repo },
              head_commit: { tree_id: tree },
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No API fixture address');
  const { port } = address;
  async function decide(): Promise<string> {
    writeFileSync(output, '');
    const child = spawn(process.execPath, ['scripts/full-run.ts'], {
      env: {
        PATH: process.env['PATH'],
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repo,
        GITHUB_SHA: 'd'.repeat(40),
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GH_TOKEN: 'synthetic-proof-token',
      },
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(0);
    return readFileSync(output, 'utf8');
  }
  try {
    expect(await decide()).toBe('scope=full\n');
    queueReadable = false;
    const finalPushScope = await decide();
    expect(requested.some((path) => path.includes('status=in_progress'))).toBe(true);
    expect(finalPushScope).toBe('scope=full\n');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

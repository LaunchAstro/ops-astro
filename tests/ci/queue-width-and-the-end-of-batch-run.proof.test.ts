// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-promise-executor-return, unicorn/no-array-callback-reference -- a review proof, kept as written */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

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

it('queue width fits the measured 60 runner slots after the shard increase', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const policy = JSON.parse(readFileSync('.github/required-checks.json', 'utf8'));
  const parallelShards = ['check', 'database-shard', 'isolation'].reduce(
    (sum, key) => sum + ci.jobs[key].strategy.matrix.shard.length,
    0,
  );
  const width = policy.merge_queue.max_entries_to_build;
  expect(
    width * parallelShards,
    `${width} simultaneous merge groups can request ${parallelShards} parallel shard runners each`,
  ).toBeLessThanOrEqual(60);
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

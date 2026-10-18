// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('delayed main pushes keep only the final full run after the batch drains', async () => {
  const repo = 'LaunchAstro/ops-astro';
  const commits = ['1'.repeat(40), '2'.repeat(40)];
  const trees = ['a'.repeat(40), 'b'.repeat(40)];
  const dir = mkdtempSync(join(tmpdir(), 'sol1489-drained-batch-'));
  const event = join(dir, 'event.json');
  const output = join(dir, 'output');
  const reads: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    reads.push(path);
    response.setHeader('content-type', 'application/json');
    if (path === '/graphql') {
      response.end(
        JSON.stringify({ data: { repository: { mergeQueue: { entries: { totalCount: 0 } } } } }),
      );
    } else if (path.includes('/git/commits/')) {
      const index = commits.indexOf(path.split('/').at(-1) ?? '');
      response.end(JSON.stringify({ tree: { sha: trees[index] } }));
    } else if (path.includes('/actions/workflows/ci.yml/runs')) {
      response.end(
        JSON.stringify({
          workflow_runs: trees.map((tree, index) => ({
            id: index + 1,
            event: 'merge_group',
            path: '.github/workflows/ci.yml',
            repository: { full_name: repo },
            head_commit: { id: commits[index], tree_id: tree },
            status: 'completed',
            conclusion: 'success',
          })),
        }),
      );
    } else if (path.endsWith('/git/ref/heads/main') || path.endsWith('/commits/main')) {
      response.end(
        JSON.stringify({
          sha: commits[1],
          object: { sha: commits[1] },
          commit: { tree: { sha: trees[1] } },
        }),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  try {
    const scopes: string[] = [];
    for (const [index, sha] of commits.entries()) {
      writeFileSync(
        event,
        JSON.stringify({
          ref: 'refs/heads/main',
          before: index === 0 ? '9'.repeat(40) : commits[0],
          after: sha,
          head_commit: { id: sha },
        }),
      );
      writeFileSync(output, '');
      const child = spawn(process.execPath, ['scripts/full-run.ts'], {
        env: {
          PATH: process.env['PATH'],
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: repo,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: sha,
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GH_TOKEN: 'synthetic-sol-proof-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', (chunk: Buffer) => {
        log += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        log += chunk.toString();
      });
      // eslint-disable-next-line no-await-in-loop -- one push after another, as main receives them
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code, log).toBe(0);
      expect(log).toContain('tested this tree');
      scopes.push(readFileSync(output, 'utf8'));
    }
    expect(reads.filter((path) => path === '/graphql')).toHaveLength(2);
    expect(scopes).toEqual(['scope=light\n', 'scope=full\n']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

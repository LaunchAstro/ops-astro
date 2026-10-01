// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARTS, revertPart } from './self-test/mutations.ts';

const root = resolve(import.meta.dirname, '../..');

test('T2b business and client crossings run when T2b is unwired beside the inbox', () => {
  const container = process.env.FIXTURE_PG_CONTAINER;
  const databaseUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(container && databaseUrl && adminUrl, 'use an owned Postgres container');
  const published = execFileSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  for (const value of [databaseUrl, adminUrl]) {
    const url = new URL(value);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.ok(published.includes(`:${url.port}`), 'the database must be the owned container');
  }

  const dir = mkdtempSync(join(tmpdir(), 't2b-inbox-unwire-'));
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, dir], {
      stdio: 'ignore',
    });
    const git = (args) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    git(['checkout', '--detach', base]);
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const scratch = {
      dir,
      branch: 'detached',
      base,
      git,
      reset: () => {
        git(['reset', '--hard', base]);
        git(['clean', '-ffdq']);
      },
      commit: (message) => {
        git(['add', '-A']);
        git([
          '-c',
          'user.name=Integration check',
          '-c',
          'user.email=review@invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '--allow-empty',
          '--no-verify',
          '-m',
          message,
        ]);
        return git(['rev-parse', 'HEAD']).trim();
      },
      close: () => {},
    };
    const part = PARTS.find((one) => one.id === 'T2b');
    assert.ok(part);
    assert.ok(revertPart(scratch, part, true).applied);

    const run = spawnSync(
      join(dir, 'node_modules/.bin/vitest'),
      ['run', 'tests/api/t2b-worker.test.ts', '-t', 'T2 isolation:', '--reporter=verbose'],
      { cwd: dir, env: process.env, encoding: 'utf8', timeout: 120_000 },
    );
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    assert.notEqual(run.status, 0, 'the unwired crossings must fail');
    assert.doesNotMatch(output, /surface\.ts: inbox\.seen has no declaration row/u);
    assert.match(output, /> T2 isolation: business to business/u);
    assert.match(output, /> T2 isolation: client to client/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

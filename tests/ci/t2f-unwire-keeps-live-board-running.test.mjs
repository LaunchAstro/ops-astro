// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARTS, revertPart } from './self-test/mutations.ts';

const root = resolve(import.meta.dirname, '../..');

test('T2f unwire keeps the INB-1 live board running', () => {
  const container = process.env.FIXTURE_PG_CONTAINER;
  const databaseUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(container && databaseUrl && adminUrl, 'use an isolated Postgres container');
  const published = execFileSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  for (const value of [databaseUrl, adminUrl]) {
    const url = new URL(value);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.ok(published.includes(`:${url.port}`), 'both database URLs must use that container');
  }

  const dir = mkdtempSync(join(tmpdir(), 't2f-live-board-unwire-'));
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, dir]);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const git = (args) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['checkout', '--detach', base]);
    const install = () => symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const board = () =>
      spawnSync(join(dir, 'node_modules/.bin/vitest'), ['run', 'tests/api/inb1f-live-board.test.ts'], {
        cwd: dir,
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });
    install();
    assert.equal(board().status, 0, 'the INB-1 live board must start at the unmutated head');

    const scratch = {
      dir,
      base,
      branch: 'detached',
      git,
      reset: () => {
        git(['reset', '--hard', base]);
        git(['clean', '-ffdq']);
      },
      commit: (message) => {
        git(['add', '-A']);
        git([
          '-c',
          'user.name=Self-test proof',
          '-c',
          'user.email=proof@invalid',
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
    const part = PARTS.find((candidate) => candidate.id === 'T2f');
    assert.ok(part);
    assert.equal(revertPart(scratch, part, true).applied, true);
    const mutated = board();
    const missingListener = `${mutated.stdout ?? ''}\n${mutated.stderr ?? ''}`.includes(
      'connectListener is not a function',
    );
    assert.equal(
      mutated.status,
      0,
      `the INB-1 live board must still run under T2f's unwire; ${missingListener ? 'connectListener is not a function' : 'the suite failed'}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

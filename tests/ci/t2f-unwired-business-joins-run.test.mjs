// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARTS, revertPart } from './self-test/mutations.ts';

const root = resolve(import.meta.dirname, '../..');
const marker = 'SOL_T2F_FOREIGN_BUSINESS_JOIN_REACHED';

test('Sol proof, criterion 1: T2f foreign-business joins execute under its unwire', () => {
  const container = process.env.FIXTURE_PG_CONTAINER;
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(container && databaseUrl, 'point the proof at your own Postgres container');
  const published = execFileSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  const database = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
  assert.ok(published.includes(`:${database.port}`), 'DATABASE_URL must use that container');

  const dir = mkdtempSync(join(tmpdir(), 'sol-194c-'));
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, dir]);
    const base =
      process.env.SOL_PROOF_BASE_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    const git = (args) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
          'user.name=Sol proof',
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
    const part = PARTS.find((candidate) => candidate.id === 'T2f');
    assert.ok(part);
    assert.ok(revertPart(scratch, part, true).applied);

    const file = join(dir, 'tests/api/t2f-live-channel.test.ts');
    const source = readFileSync(file, 'utf8');
    const line = '      const foreignToken = await tokenFor(other.member.presented.subject);';
    assert.equal(source.split(line).length, 2);
    writeFileSync(file, source.replace(line, `      console.warn('${marker}');\n${line}`));

    const run = spawnSync(
      join(dir, 'node_modules/.bin/vitest'),
      [
        'run',
        'tests/api/t2f-live-channel.test.ts',
        '-t',
        'T2 isolation \\(T2f\\)',
        '--reporter=verbose',
      ],
      { cwd: dir, env: process.env, encoding: 'utf8', timeout: 120_000 },
    );
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    assert.notEqual(run.status, 0, 'the T2f unwire must make the case red');
    assert.match(output, /T2 isolation \(T2f\)/u, 'the named case must execute');
    assert.ok(output.includes(marker), 'the case stops before either foreign-business join');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

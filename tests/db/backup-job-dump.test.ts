// SPDX-License-Identifier: AGPL-3.0-only
// Review proofs for the S0-3b backup job at cad2f8b.
// Sol's proof bodies stay byte-for-byte, and the dump stand-in is an EventEmitter
// because the child process it replaces is one, so this one rule is off here only.
/* oxlint-disable unicorn/prefer-event-target */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

const { dumpSpawn } = vi.hoisted(() => ({
  dumpSpawn: vi.fn((_command: string, _args: string[]): unknown => undefined),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: dumpSpawn,
}));

it('nightly dump includes the auth schema', async () => {
  dumpSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('PGDMP'));
      child.emit('close', 0);
    });
    return child;
  });
  const path = '../../scripts/ops/backup.mjs';
  const { pgDump }: { pgDump: (sourceUrl: string) => Promise<Buffer> } = await import(
    /* @vite-ignore */ path
  );
  await pgDump('postgres://backup:secret@example.test/product');
  const args = dumpSpawn.mock.calls[0]?.[1];
  expect(args).toContain('--schema=auth');
});

it('missing credentials leave a failed run in the scheduled log', () => {
  const root = resolve(import.meta.dirname, '../..');
  const result = spawnSync(process.execPath, ['scripts/ops/backup.mjs', 'run'], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  });
  expect(result.stdout.trim()).toMatch(/"event":"backup run","outcome":"failed"/u);
  expect(result.status).toBe(1);
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The nightly dump's container logs nothing (review o2-4). An attached
// `docker run` still writes the container's stdout through the daemon's
// logging driver, by default `json-file` on the host's disk, so without
// `--log-driver=none` the whole unsealed pg_dump would sit in a log file until
// `--rm` removed the container. The stand-in is an EventEmitter because the
// child process it replaces is one.
/* oxlint-disable unicorn/prefer-event-target */

import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const { dumpSpawn } = vi.hoisted(() => ({
  dumpSpawn: vi.fn((_command: string, _args: string[]): unknown => undefined),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: dumpSpawn,
}));

it('the dump container writes nothing to the daemon log', async () => {
  dumpSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('PGDMP'));
      child.emit('close', 0);
    });
    return child;
  });
  const path = '../../scripts/ops/backup-dump.mjs';
  const { pgDump }: { pgDump: (sourceUrl: string) => Promise<unknown> } = await import(
    /* @vite-ignore */
    path
  );
  await pgDump('postgres://backup:secret@example.test/product');
  expect(dumpSpawn.mock.calls[0]?.[0]).toBe('docker');
  const args = dumpSpawn.mock.calls[0]?.[1] ?? [];
  expect(args).toContain('--log-driver=none');
  expect(args.indexOf('--log-driver=none')).toBeLessThan(args.indexOf('pg_dump'));
});

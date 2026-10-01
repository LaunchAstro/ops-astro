// SPDX-License-Identifier: AGPL-3.0-only
// Review proof (REVIEW-MAIN-B1 p10-1): when the store refuses an upload part
// way through (53400 full, a refused login, the store down), the scheduled
// backup reports failed but never stops the pg_dump it started. pgDump's
// reader pauses the child once a few pieces wait, so pg_dump blocks on a full
// pipe, keeps its snapshot and ACCESS SHARE locks on the source, and keeps the
// job's node process alive, so launchd never starts the next night's run.
// Both docker invocations (pg_dump and psql) are stand-ins; the job, the dump
// reader and the psql route are the real modules.
/* oxlint-disable unicorn/prefer-event-target */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

type Dump = EventEmitter & {
  stdout: EventEmitter & { paused: boolean; pause: () => void; resume: () => void };
  killed: boolean;
  kill: () => boolean;
};

const { spawned } = vi.hoisted(() => ({
  spawned: { dumps: [] as unknown[], timers: [] as NodeJS.Timeout[] },
}));

/** pg_dump in its container: prints 256 KiB pieces while read, until it is stopped. */
function dumpChild(): Dump {
  const stdout = Object.assign(new EventEmitter(), {
    paused: false,
    pause() {
      stdout.paused = true;
    },
    resume() {
      stdout.paused = false;
    },
  });
  const timer = setInterval(() => {
    if (!stdout.paused) stdout.emit('data', randomBytes(256 * 1024));
  }, 1);
  timer.unref();
  spawned.timers.push(timer);
  const child: Dump = Object.assign(new EventEmitter(), {
    stdout,
    killed: false,
    kill: () => {
      child.killed = true;
      clearInterval(timer);
      setImmediate(() => child.emit('close', null));
      return true;
    },
  });
  spawned.dumps.push(child);
  return child;
}

/** psql against the store: takes the opening lines, then the store refuses the first part and psql stops (ON_ERROR_STOP, exit 3). */
function psqlChild() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin: undefined as unknown as Writable,
    kill: () => true,
  });
  let writes = 0;
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      if (writes < 2) {
        callback();
        return;
      }
      callback(new Error('EPIPE'));
      stdout.end();
      setImmediate(() => child.emit('close', 3));
    },
  });
  return child;
}

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (_command: string, args: string[]) =>
    args.includes('pg_dump') ? dumpChild() : psqlChild(),
}));

afterEach(() => {
  for (const timer of spawned.timers) clearInterval(timer);
});

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

it('a backup the store refuses part way through stops its pg_dump', async () => {
  const path = '../../scripts/ops/backup.mjs';
  const { runBackup, pgDump } = (await import(/* @vite-ignore */ path)) as {
    runBackup: (options: Record<string, unknown>) => Promise<{ outcome: string }>;
    pgDump: (url: string) => Promise<unknown>;
  };
  const run = await runBackup({
    dump: () => pgDump('postgres://backup:made-up@pooler:6543/postgres'),
    storeUrl: 'postgres://job:made-up@backups:5432/ops_astro_staging_backups',
    publicKey: keys.publicKey,
    send: () => Promise.resolve('sent'),
  });
  expect(run.outcome).toBe('failed');
  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });
  const [dump] = spawned.dumps as Dump[];
  expect(dump, 'pg_dump was started').toBeDefined();
  expect(
    dump?.killed,
    'refused store upload leaves pg_dump running: runBackup failed but never stopped the dump child (paused pipe, held snapshot, job process never exits)',
  ).toBe(true);
}, 20_000);

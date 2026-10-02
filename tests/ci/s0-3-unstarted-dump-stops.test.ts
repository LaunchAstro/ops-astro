// SPDX-License-Identifier: AGPL-3.0-only
// Review o-1 (REVIEW-o, the p10-1 residual): a backup that fails before the
// store pulls its first dump piece still stops the pg_dump it started. A store
// reach that refuses before reading, a store URL that does not parse and a
// public key the seal cannot use each fail the run; pg_dump must be killed in
// each, or it blocks on a full pipe holding its snapshot and ACCESS SHARE
// locks, and the job's node process never exits.
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

async function runWith(overrides: Record<string, unknown>) {
  const path = '../../scripts/ops/backup.mjs';
  const { runBackup, pgDump } = (await import(/* @vite-ignore */ path)) as {
    runBackup: (options: Record<string, unknown>) => Promise<{ outcome: string; stage?: string }>;
    pgDump: (url: string) => Promise<unknown>;
  };
  const before = spawned.dumps.length;
  const run = await runBackup({
    dump: () => pgDump('postgres://backup:made-up@pooler:6543/postgres'),
    storeUrl: 'postgres://job:made-up@backups:5432/ops_astro_staging_backups',
    publicKey: keys.publicKey,
    send: () => Promise.resolve('sent'),
    ...overrides,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });
  return { run, dump: spawned.dumps[before] as Dump };
}

it('a store reach that refuses before pulling the dump stops pg_dump', async () => {
  const { run, dump } = await runWith({ reach: () => Promise.reject(new Error('refused')) });
  expect(run.outcome).toBe('failed');
  expect(dump.killed).toBe(true);
}, 20_000);

it('a malformed store URL (real stagingReach) stops pg_dump', async () => {
  const { run, dump } = await runWith({ storeUrl: 'not a url' });
  expect(run).toMatchObject({ outcome: 'failed', stage: 'store' });
  expect(dump.killed).toBe(true);
}, 20_000);

it('an unusable public key (seal stage) stops pg_dump', async () => {
  const { run, dump } = await runWith({ publicKey: 'ssh-rsa AAAAnot-a-pem-key operator' });
  expect(run).toMatchObject({ outcome: 'failed', stage: 'seal' });
  expect(dump.killed).toBe(true);
}, 20_000);

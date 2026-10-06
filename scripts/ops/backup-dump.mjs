// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled backup's dump (ticket S0-3, line C1; backup.mjs): pg_dump of
// the product's schemas and `auth` (not on hosted Supabase) in a throwaway container of staging's own
// pinned Postgres image, handed on as it prints, so the job never holds a dump
// whole (REV158S criterion 5).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BACKUP_ROLE = 'ops_astro_backup';
// The product's schemas, the auth server's sign-in data in the same database,
// and staging's made-up guard, whose functions the guarded tables' triggers call.
// A database without the guard has no such schema, and pg_dump skips it.
export const SCHEMAS = ['public', 'ops', 'auth', 'ops_astro_made_up'];
// On hosted Supabase `auth` is the platform's: our owner may use it but not
// grant on it, and no platform role is granted to the backup identity (#999,
// migrations/20261006140500_backup_reach_checked.sql). The hosted dump leaves it
// out; its sign-ins stay in Supabase's own project backup, and staging's
// made-up cast gets them back from the reset's sign-in step (staging-reset.mjs).
const HOSTED = /^[a-z0-9-]+\.pooler\.supabase\.com$/u;

/** The schemas dumped from `host`, as the URL parser reads it. */
export function schemasFrom(host) {
  return HOSTED.test(host.toLowerCase()) ? SCHEMAS.filter((schema) => schema !== 'auth') : SCHEMAS;
}

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

/**
 * pg_dump in a throwaway container on staging's network, as the backup
 * identity. The password reaches the container through the environment, never
 * the command line, and pg_dump's own messages are discarded. It answers once
 * pg_dump has printed its first bytes: the pieces it prints, which throw after
 * the last if pg_dump failed, with a `stop()` for a reader that gives up. A
 * pg_dump that prints nothing fails.
 */
export function pgDump(sourceUrl) {
  const url = new URL(sourceUrl);
  const args = [
    'run',
    '--rm',
    // Attached output still streams; none of the dump goes to a log on the host's disk.
    '--log-driver=none',
    `--name=${staging['x-ops-astro'].ownPrefix}-backup-${randomBytes(4).toString('hex')}`,
    `--network=${staging.networks.staging.name}`,
    '--env=PGPASSWORD',
    '--env=PGSSLMODE',
    staging.services.backups.image,
    'pg_dump',
    '--format=custom',
    `--role=${BACKUP_ROLE}`,
    ...schemasFrom(url.hostname).map((schema) => `--schema=${schema}`),
    `--host=${url.hostname}`,
    `--port=${url.port || '5432'}`,
    `--username=${decodeURIComponent(url.username)}`,
    `--dbname=${url.pathname.slice(1)}`,
  ];
  const child = spawn('docker', args, {
    // TLS or no dump: the source's bytes are plaintext until the job seals them.
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: 'require' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return printed(child);
}

/**
 * Settles once `child` has exited and its pipes have closed, or after `ms`, when
 * it is killed outright and left, so a stopped dump never holds the job open.
 */
function closed(child, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill?.('SIGKILL');
      resolve();
    }, ms);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A child's printed pieces, read as they come and paused while a few wait,
 * once it has printed something. Their `stop()` stops the child, drops what it
 * still prints so its pipe can close, and waits for it to exit, whether or not
 * the pieces were ever read.
 */
function printed(child) {
  const waiting = [];
  let [exit, wake] = [null, () => {}];
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', (piece) => {
      waiting.push(piece);
      if (waiting.length > 4) child.stdout.pause?.();
      resolve();
      wake();
    });
    const end = (code) => {
      exit ??= code;
      if (waiting.length === 0) reject(new Error('pg_dump failed'));
      wake();
    };
    child.on('error', () => end(-1));
    child.on('close', (code) => end(code));
  });
  const more = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  async function* pieces() {
    for (;;) {
      if (waiting.length > 0) {
        child.stdout.resume?.();
        yield waiting.shift();
      } else if (exit === null) {
        // oxlint-disable-next-line no-await-in-loop -- one piece at a time is the point
        await more();
      } else break;
    }
    if (exit !== 0) throw new Error('pg_dump failed');
  }
  async function stop() {
    child.kill?.();
    child.stdout.removeAllListeners?.('data').resume?.();
    if (exit === null) await closed(child);
  }
  return started.then(() => Object.assign(pieces(), { stop }));
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled backup's dump (ticket S0-3, line C1; backup.mjs): pg_dump of
// the product's schemas and `auth` (not on hosted Supabase) in a throwaway container of staging's own
// pinned Postgres image, handed on as it prints, so the job never holds a dump
// whole (REV158S criterion 5).

import { readFileSync } from 'node:fs';
import { reachEnv } from './backup-store-reach.mjs';
import { runContainer } from './container-run.mjs';

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
// The job reaches staging only by the pooler (backup.mjs, OPS_EGRESS_POOLER_*),
// so the pooler's name is the sign.
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
 * identity. The login reaches it as psql's does (`reachEnv`, the database
 * name decoded, TLS required), through the environment, never the command
 * line, and pg_dump's own messages are discarded. It answers once pg_dump has
 * printed its first bytes: the pieces it prints, which throw after the last if
 * pg_dump failed, with a `stop()` for a reader that gives up. A pg_dump that
 * prints nothing fails.
 */
export function pgDump(sourceUrl) {
  plainDatabase(sourceUrl);
  const login = reachEnv(sourceUrl);
  const run = runContainer('backup', staging.networks.staging.name, login, [
    'pg_dump',
    '--format=custom',
    `--role=${BACKUP_ROLE}`,
    ...schemasFrom(login.PGHOST).map((schema) => `--schema=${schema}`),
  ]);
  return printed(run);
}

/**
 * Refuses a dump whose database name is not a plain identifier: pg_dump reads
 * a name holding `=` or a URI as a connection of its own, whose host wins
 * (#999). An address the parser cannot read is left to `reachEnv`'s refusal.
 */
function plainDatabase(sourceUrl) {
  let name;
  try {
    name = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  } catch {
    return;
  }
  if (!/^[A-Za-z0-9_]{1,63}$/u.test(name)) throw new Error('not a plain database name');
}

/**
 * A run's printed pieces, read as they come and paused while a few wait, once
 * it has printed something. Their `stop()` stops the run and waits for it,
 * whether or not the pieces were ever read.
 */
function printed(run) {
  const { child } = run;
  const waiting = [];
  let [ended, failure, wake] = [false, undefined, () => {}];
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', (piece) => {
      waiting.push(piece);
      if (waiting.length > 4) child.stdout.pause();
      resolve();
      wake();
    });
    // A container docker would not remove fails the dump with that reason.
    void run.exited
      .then(
        (ok) => (ok ? undefined : new Error('pg_dump failed')),
        (error) => error,
      )
      .then((error) => {
        [ended, failure] = [true, error];
        if (waiting.length === 0) reject(error ?? new Error('pg_dump failed'));
        return wake();
      });
  });
  const more = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  async function* pieces() {
    for (;;) {
      if (waiting.length > 0) {
        child.stdout.resume();
        yield waiting.shift();
      } else if (ended) break;
      // oxlint-disable-next-line no-await-in-loop -- one piece at a time is the point
      else await more();
    }
    if (failure !== undefined) throw failure;
  }
  async function stop() {
    child.stdout.removeAllListeners('data').resume();
    await run.stop();
  }
  return started.then(() => Object.assign(pieces(), { stop }));
}

/**
 * Stops a dump `source` a backup gives up on: answers `stage`, or `container`
 * when docker would not remove its container (the run says which).
 */
export const stopped = (source, stage) =>
  Promise.resolve(source.stop?.()).then(
    () => stage,
    () => 'container',
  );

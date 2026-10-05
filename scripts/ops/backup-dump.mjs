// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled backup's dump (ticket S0-3, line C1; backup.mjs): pg_dump of
// the product's schemas and `auth` in a throwaway container of staging's own
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
  const run = runContainer('backup', staging.networks.staging.name, reachEnv(sourceUrl), [
    'pg_dump',
    '--format=custom',
    `--role=${BACKUP_ROLE}`,
    ...SCHEMAS.map((schema) => `--schema=${schema}`),
  ]);
  return printed(run);
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

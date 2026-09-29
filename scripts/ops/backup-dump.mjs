// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled backup's dump (ticket S0-3, line C1; backup.mjs): pg_dump of
// the product's schemas and `auth` in a throwaway container of staging's own
// pinned Postgres image, handed on as it prints, so the job never holds a dump
// whole (REV158S criterion 5).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BACKUP_ROLE = 'ops_astro_backup';
// The product's schemas and the auth server's sign-in data in the same database.
const SCHEMAS = ['public', 'ops', 'auth'];

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

/**
 * pg_dump in a throwaway container on staging's network, as the backup
 * identity. The password reaches the container through the environment, never
 * the command line, and pg_dump's own messages are discarded. It answers once
 * pg_dump has printed its first bytes: the pieces it prints, which throw after
 * the last if pg_dump failed. A pg_dump that prints nothing fails.
 */
export function pgDump(sourceUrl) {
  const url = new URL(sourceUrl);
  const args = [
    'run',
    '--rm',
    `--name=${staging['x-ops-astro'].ownPrefix}-backup-${randomBytes(4).toString('hex')}`,
    `--network=${staging.networks.staging.name}`,
    '--env=PGPASSWORD',
    '--env=PGSSLMODE',
    staging.services.db.image,
    'pg_dump',
    '--format=custom',
    `--role=${BACKUP_ROLE}`,
    ...SCHEMAS.map((schema) => `--schema=${schema}`),
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
 * A child's printed pieces, read as they come and paused while a few wait,
 * once it has printed something; stops the child if the reader stops first.
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
    let done = false;
    try {
      for (;;) {
        if (waiting.length > 0) {
          child.stdout.resume?.();
          yield waiting.shift();
        } else if (exit === null) {
          // oxlint-disable-next-line no-await-in-loop -- one piece at a time is the point
          await more();
        } else break;
      }
      done = true;
    } finally {
      if (!done) child.kill?.();
    }
    if (exit !== 0) throw new Error('pg_dump failed');
  }
  return started.then(() => pieces());
}

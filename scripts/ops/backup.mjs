// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's scheduled backup and its retention job (ticket S0-3, lines C1 and
// C11). launchd runs each from its own job in deploy/staging/, under its own
// identity:
//
//   node --env-file=<backup env> scripts/ops/backup.mjs run
//     BACKUP_SOURCE_URL  a login holding ops_astro_backup (migration 0034),
//                        its host as staging's network names the database
//     BACKUP_STORE_URL   a login holding ops_astro_backup on the backup store,
//                        its host as staging's network names the store (backups)
//     BACKUP_PUBLIC_KEY_FILE  the operator's public key; its private half is
//                        held apart, never on this job's machine account
//     OPS_BACKUP_HEARTBEAT_URL  the watcher's backup heartbeat, pinged once a
//                        backup is recorded
//   node --env-file=<retention env> scripts/ops/backup.mjs expire
//     BACKUP_RETENTION_URL  a login holding ops_astro_backup_retention on the
//                        backup store
//     OPS_RESTORE_HEARTBEAT_URL  the watcher's restore heartbeat, pinged only
//                        while a restore drill passed inside the store's window
//
// `run` takes one pg_dump of the product's schemas and `auth`, in a throwaway
// container of staging's own pinned Postgres image, seals it (archive-seal.mjs)
// and adds only the sealed artefact to the store. `expire` deletes every
// backup past the store's window, then asks the store whether a restore drill
// passed inside its window: yes pings the restore heartbeat, no stays silent,
// and the watcher mails the owner and the second operator (heartbeat.mjs).
// What each may do is held by the server
// (deploy/staging/backup-store.sql), which writes receipts. Both reach the
// store only through psql on staging's network (backup-store-reach.mjs): it
// publishes no port.
//
// Each run prints one JSON line, recorded or failed, and exits 0 or 1. A
// failed line names the stage and nothing else: an error from pg_dump or the
// server can carry a host, a login or a password, so its text is never kept.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sealArchive } from './archive-seal.mjs';
import { stagingReach, value } from './backup-store-reach.mjs';
import { ping } from './heartbeat.mjs';

const BACKUP_ROLE = 'ops_astro_backup';
const RETENTION_ROLE = 'ops_astro_backup_retention';
// The product's schemas and the auth server's sign-in data in the same database.
const SCHEMAS = ['public', 'ops', 'auth'];

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

/**
 * pg_dump in a throwaway container on staging's network, as the backup
 * identity. The password reaches the container through the environment, never
 * the command line, and pg_dump's own messages are discarded.
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
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      // TLS or no dump: the source's bytes are plaintext until the job seals them.
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: 'require' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => reject(new Error('pg_dump did not start')));
    child.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error('pg_dump failed'));
    });
  });
}

/** A run's record when it fails: the stage only, never an error's text. */
function failed(event, stage) {
  return { event, outcome: 'failed', stage, at: new Date().toISOString() };
}

/** One scheduled backup. Returns the run's record; never throws. */
export async function runBackup({
  dump,
  storeUrl,
  publicKey,
  heartbeat,
  send = ping,
  reach = stagingReach,
}) {
  const at = new Date().toISOString();
  let body;
  try {
    body = await dump();
  } catch {
    return failed('backup run', 'dump');
  }
  try {
    body = sealArchive(body, publicKey);
  } catch {
    return failed('backup run', 'seal');
  }
  try {
    // The server judges the insert as the backup identity, and stamps it.
    await reach(
      storeUrl,
      `set role ${BACKUP_ROLE};\ninsert into backups.archives (body) values (${value(body, 'bytea')});\n`,
    );
  } catch {
    return failed('backup run', 'store');
  }
  const record = { event: 'backup run', outcome: 'recorded', at, bytes: body.length };
  return { ...record, heartbeat: await send(heartbeat) };
}

/**
 * Deletes every backup past the window. The store's policy is what holds the
 * window; the job asks for everything and the server deletes only what it may.
 */
export async function expireBackups({
  storeUrl,
  restoreHeartbeat,
  send = ping,
  reach = stagingReach,
}) {
  const at = new Date().toISOString();
  let upkeep;
  try {
    upkeep = JSON.parse(
      await reach(
        storeUrl,
        `set role ${RETENTION_ROLE};
with gone as (delete from backups.archives returning id)
select json_build_object('count', (select count(*) from gone), 'fresh', backups.restore_fresh())::text;
`,
      ),
    );
  } catch {
    return failed('backup expired', 'store');
  }
  const record = { event: 'backup expired', outcome: 'recorded', at, count: upkeep.count };
  // A stale restore is told by silence: the watcher mails when the ping is late.
  const beat = upkeep.fresh ? await send(restoreHeartbeat) : 'withheld';
  return { ...record, restoreFresh: upkeep.fresh, restoreHeartbeat: beat };
}

/** An unset or empty variable reads as unset. */
function env(name) {
  return process.env[name] || undefined;
}

/** The operator's public key, or undefined when its file is unset or unreadable. */
function readKey(path) {
  try {
    return path === undefined ? undefined : readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function main(command) {
  if (command === 'run') {
    const [source, storeUrl] = [env('BACKUP_SOURCE_URL'), env('BACKUP_STORE_URL')];
    const publicKey = readKey(env('BACKUP_PUBLIC_KEY_FILE'));
    if (source === undefined || storeUrl === undefined || publicKey === undefined) {
      return failed('backup run', 'config');
    }
    const heartbeat = env('OPS_BACKUP_HEARTBEAT_URL');
    return await runBackup({ dump: () => pgDump(source), storeUrl, publicKey, heartbeat });
  }
  if (command === 'expire') {
    const storeUrl = env('BACKUP_RETENTION_URL');
    if (storeUrl === undefined) return failed('backup expired', 'config');
    return await expireBackups({ storeUrl, restoreHeartbeat: env('OPS_RESTORE_HEARTBEAT_URL') });
  }
  return undefined;
}

// A run that cannot start is still a run: it goes to the job's log like any
// other, so a missing credential is seen where a failed dump would be.
if (import.meta.url === `file://${process.argv[1]}`) {
  const record = await main(process.argv[2]);
  if (record === undefined) {
    process.stderr.write('usage: backup.mjs run | expire\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    process.exitCode = record.outcome === 'recorded' ? 0 : 1;
  }
}

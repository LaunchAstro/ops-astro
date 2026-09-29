// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's scheduled backup and its retention job (ticket S0-3, lines C1 and
// C11). launchd runs each from its own job in deploy/staging/, under its own
// identity:
//
//   node --env-file=<backup env> scripts/ops/backup.mjs run
//     BACKUP_SOURCE_URL  a login holding ops_astro_backup (migration 0034),
//                        its host as staging's network names the database
//     BACKUP_STORE_URL   the same login, on the backup store
//   node --env-file=<retention env> scripts/ops/backup.mjs expire
//     BACKUP_RETENTION_URL  a login holding ops_astro_backup_retention
//
// `run` takes one pg_dump of the product's schemas, in a throwaway container
// of staging's own pinned Postgres image, and adds it to the store. `expire`
// deletes every backup past the store's window. What each may do is held by
// the server (deploy/staging/backup-store.sql); the store writes the receipts.
//
// Each run prints one JSON line, recorded or failed, and exits 0 or 1. A
// failed line names the stage and nothing else: an error from pg_dump or the
// server can carry a host, a login or a password, so its text is never kept.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const BACKUP_ROLE = 'ops_astro_backup';
const RETENTION_ROLE = 'ops_astro_backup_retention';
const SCHEMAS = ['public', 'ops'];

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

/** One session holding `role`, so the server judges every statement as that role. */
async function asRole(url, role, run) {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    await sql.unsafe(`set role ${role}`);
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

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
    '--name',
    `${staging['x-ops-astro'].ownPrefix}-backup-${randomBytes(4).toString('hex')}`,
    '--network',
    staging.networks.staging.name,
    '-e',
    'PGPASSWORD',
    staging.services.db.image,
    'pg_dump',
    '--format=custom',
    `--role=${BACKUP_ROLE}`,
    ...SCHEMAS.map((schema) => `--schema=${schema}`),
    '--host',
    url.hostname,
    '--port',
    url.port || '5432',
    '--username',
    decodeURIComponent(url.username),
    '--dbname',
    url.pathname.slice(1),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
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

/** One scheduled backup. Returns the run's record; never throws. */
export async function runBackup({ dump, storeUrl }) {
  const at = new Date().toISOString();
  let body;
  try {
    body = await dump();
  } catch {
    return { event: 'backup run', outcome: 'failed', stage: 'dump', at };
  }
  try {
    await asRole(
      storeUrl,
      BACKUP_ROLE,
      (sql) => sql`insert into backups.archives (body) values (${body})`,
    );
  } catch {
    return { event: 'backup run', outcome: 'failed', stage: 'store', at };
  }
  return { event: 'backup run', outcome: 'recorded', at, bytes: body.length };
}

/**
 * Deletes every backup past the window. The store's policy is what holds the
 * window; the job asks for everything and the server deletes only what it may.
 */
export async function expireBackups({ storeUrl }) {
  const at = new Date().toISOString();
  try {
    const deleted = await asRole(
      storeUrl,
      RETENTION_ROLE,
      (sql) => sql`delete from backups.archives returning id`,
    );
    return { event: 'backup expired', outcome: 'recorded', at, count: deleted.count };
  } catch {
    return { event: 'backup expired', outcome: 'failed', stage: 'store', at };
  }
}

function need(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is unset`);
  return value;
}

async function main(command) {
  if (command === 'run') {
    const source = need('BACKUP_SOURCE_URL');
    return await runBackup({ dump: () => pgDump(source), storeUrl: need('BACKUP_STORE_URL') });
  }
  if (command === 'expire') return await expireBackups({ storeUrl: need('BACKUP_RETENTION_URL') });
  throw new Error('usage: backup.mjs run | expire');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const record = await main(process.argv[2]);
    process.stdout.write(`${JSON.stringify(record)}\n`);
    process.exitCode = record.outcome === 'recorded' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

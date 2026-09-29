// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill, `ops restore --drill` (ticket S0-3, lines C2, C3 and C8;
// LF-3). The operator runs it on the machine, from the runbook:
//
//   node --env-file=<drill env> scripts/ops/restore-drill.mjs --drill
//     RESTORE_STORE_URL  a login holding ops_astro_backup_restore on the store
//     RESTORE_KEY_FILE   the operator's private key, held apart from the store
//
// It takes the newest backup from the store (the store logs the read), opens
// the seal, starts a throwaway container of the production major with no
// network, restores into it, checks the result and removes the container. It
// takes no target: the one database it writes is the one it started, so it
// cannot reach the managed project or any other server.
//
// It stays out of apps/cli, which never opens a database (apps/cli/main.ts:7).
// Who may run it (`operations:manage`) and where its receipt is kept are S0-3d's.
//
// It prints one JSON line, passed or failed, and exits 0 or 1. A failed line
// names the stage and nothing else: Docker's, pg_restore's and the server's
// messages can carry record data, so they are never kept.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { openArchive } from './archive-seal.mjs';

const RESTORE_ROLE = 'ops_astro_backup_restore';
const SCHEMAS = ['public', 'ops'];
const DB = 'drill';
// Its own path, not the image's volume, so every major takes it.
const PGDATA = '/var/lib/postgresql/drill';

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);
const PRODUCTION_MAJOR = staging['x-ops-astro'].productionDatabaseMajor;

/** Runs `docker`; stdout comes back as text, stderr is discarded. */
export function docker(args, input) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString() }),
    );
    child.stdin.end(input);
  });
}

/** The newest backup, read as the restore identity; the store writes the receipt. */
export async function fetchLatest(storeUrl) {
  const sql = postgres(storeUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${RESTORE_ROLE}`);
      const [row] = await tx`select taken_at, body from backups.read_latest()`;
      if (row === undefined) throw new Error('no backup');
      return { takenAt: row.taken_at.toISOString(), body: row.body };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function must(result) {
  const { code, stdout } = await result;
  if (code !== 0) throw new Error('step failed');
  return stdout;
}

/**
 * Restores the archive `fetchArchive` returns into a container of `image` and
 * checks it. Returns the drill's record; never throws. `image` defaults to
 * staging's pinned Postgres, the major production gets.
 */
export async function restoreDrill({
  fetchArchive,
  privateKey,
  docker: run = docker,
  image = staging.services.db.image,
}) {
  const record = {
    event: 'restore drill',
    outcome: 'failed',
    at: new Date().toISOString(),
    target: 'throwaway container',
    productionMajor: PRODUCTION_MAJOR,
    sourceMajor: null,
    targetMajor: null,
    timings: {},
  };
  const name = `${staging['x-ops-astro'].ownPrefix}-drill-${randomBytes(4).toString('hex')}`;
  const psql = async (text) =>
    (await must(run(['exec', name, 'psql', '-U', 'postgres', '-d', DB, '-Atc', text]))).trim();
  let stage;
  const timed = async (step, work) => {
    stage = step;
    const start = performance.now();
    try {
      return await work();
    } finally {
      record.timings[step] = Math.round(performance.now() - start);
    }
  };
  let started = false;
  try {
    const archive = await timed('fetch', fetchArchive);
    record.archiveTakenAt = archive.takenAt;
    const dump = await timed('open', () => openArchive(archive.body, privateKey));
    await timed('start', async () => {
      started = true;
      // No network and no published port: nothing outside can reach it, and it
      // can reach nothing. Local trust is safe for the same reason. The data
      // directory is memory only, so restored rows never reach the disk.
      await must(
        run([
          'run',
          '-d',
          '--rm',
          '--network',
          'none',
          '--name',
          name,
          '--tmpfs',
          PGDATA,
          '-e',
          `PGDATA=${PGDATA}`,
          '-e',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          '-e',
          `POSTGRES_DB=${DB}`,
          image,
        ]),
      );
      let ready = false;
      for (let i = 0; i < 120 && !ready; i += 1) {
        // Over TCP, not the socket: the image's init server listens on the socket only.
        // oxlint-disable-next-line no-await-in-loop
        const probe = await run([
          'exec',
          name,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          DB,
        ]);
        ready = probe.code === 0;
        // oxlint-disable-next-line no-await-in-loop
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      record.targetMajor = Math.floor(Number(await psql('show server_version_num')) / 10_000);
      stage = 'target';
      if (record.targetMajor !== PRODUCTION_MAJOR) throw new Error('not the production major');
    });
    const expected = await timed('restore', async () => {
      const listed = await must(run(['exec', '-i', name, 'pg_restore', '--list'], dump));
      record.sourceMajor = Number(/Dumped from database version: (\d+)/u.exec(listed)?.[1]);
      // The archive makes its own public schema; the empty one would collide.
      await psql('drop schema public');
      await must(
        run(
          [
            'exec',
            '-i',
            name,
            'pg_restore',
            '--exit-on-error',
            '--single-transaction',
            '--no-owner',
            '--no-privileges',
            '-U',
            'postgres',
            '-d',
            DB,
          ],
          dump,
        ),
      );
      return [...listed.matchAll(/^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /gmu)].map(
        ([, schema, table]) => `${schema}.${table}`,
      );
    });
    await timed('check', async () => {
      const present = new Set(
        (
          await psql(
            `select schemaname || '.' || tablename from pg_tables where schemaname in ('${SCHEMAS.join("', '")}')`,
          )
        ).split('\n'),
      );
      const migration = await psql('select max(version) from ops.schema_migrations');
      if (expected.length === 0 || !expected.every((t) => present.has(t)) || migration === '') {
        throw new Error('restore incomplete');
      }
      record.tables = expected.length;
      record.migration = migration;
    });
    record.outcome = 'passed';
  } catch {
    record.stage = stage;
  } finally {
    // With its volumes: an image's declared volume outlives `rm -f` alone.
    if (started) await run(['rm', '-f', '-v', name]);
  }
  return record;
}

function need(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is unset`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv[2] !== '--drill') throw new Error('usage: restore-drill.mjs --drill');
    const storeUrl = need('RESTORE_STORE_URL');
    let privateKey;
    try {
      privateKey = readFileSync(need('RESTORE_KEY_FILE'), 'utf8');
    } catch {
      throw new Error('RESTORE_KEY_FILE is unset or unreadable');
    }
    const record = await restoreDrill({ fetchArchive: () => fetchLatest(storeUrl), privateKey });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    process.exitCode = record.outcome === 'passed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

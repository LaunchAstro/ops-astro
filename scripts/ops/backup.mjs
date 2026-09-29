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
// and adds only the sealed artefact to the store. The dump streams through the
// seal into the store in parts of 4 MiB, in one transaction, so neither the
// dump nor the archive is ever held whole: an archive can be as large as the
// store's cap (REV158S criterion 5). The job hashes the whole ciphertext as it
// goes and completes the archive with that digest and its size, both sent as
// bound parameters, so no statement the store logs or reports carries the
// digest. `expire` deletes every
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sealer } from './archive-seal.mjs';
import { pgDump } from './backup-dump.mjs';
import { bound, stagingReach, value } from './backup-store-reach.mjs';
import { ping } from './heartbeat.mjs';

export { pgDump } from './backup-dump.mjs';

const BACKUP_ROLE = 'ops_astro_backup';
const RETENTION_ROLE = 'ops_astro_backup_retention';
// The store's part size (deploy/staging/backup-store.sql, backups.archive_parts).
const PART = 4 * 1024 * 1024;

/** The dump's pieces, whether `dump` answered them as a stream or as one buffer. */
async function* piecesOf(source) {
  if (Buffer.isBuffer(source)) yield source;
  else yield* source;
}

/**
 * The store script for one archive, as pieces: the dump, sealed as it
 * streams, in parts of `PART` bytes, then the archive completed with its size
 * and the sha256 of its whole ciphertext, in one transaction. `failure.stage`
 * names the step that failed if the dump or the seal throws.
 */
async function* upload(source, seal, failure) {
  yield `set role ${BACKUP_ROLE};\nbegin;\n`;
  const whole = createHash('sha256');
  let [held, size, seq, bytes] = [[seal.header], seal.header.length, 0, 0];
  function* part(bytesOut) {
    whole.update(bytesOut);
    bytes += bytesOut.length;
    yield `select backups.add_part(${seq}, `;
    yield* value(bytesOut, 'bytea');
    yield ');\n';
    seq += 1;
  }
  function* flush(all) {
    // Whole parts only, until the end, when the last may be short.
    const under = all ? 0 : PART - 1;
    while (size > under) {
      const joined = Buffer.concat(held);
      const out = joined.subarray(0, PART);
      held = [joined.subarray(out.length)];
      size = joined.length - out.length;
      yield* part(out);
    }
  }
  const pieces = piecesOf(source)[Symbol.asyncIterator]();
  for (;;) {
    failure.stage = 'dump';
    // oxlint-disable-next-line no-await-in-loop -- one piece at a time is the point
    const next = await pieces.next();
    failure.stage = 'seal';
    if (next.done) break;
    held.push(seal.update(next.value));
    size += held.at(-1).length;
    failure.stage = null;
    yield* flush(false);
  }
  held.push(seal.final());
  size += held.at(-1).length;
  failure.stage = null;
  yield* flush(true);
  yield bound('select backups.complete_archive($1::bigint, $2::text)', [
    bytes,
    whole.digest('hex'),
  ]);
  yield 'commit;\n';
  failure.bytes = bytes;
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
  let source;
  try {
    source = await dump();
  } catch {
    return failed('backup run', 'dump');
  }
  let seal;
  try {
    seal = sealer(publicKey);
  } catch {
    return failed('backup run', 'seal');
  }
  const failure = { stage: null, bytes: 0 };
  try {
    // The server judges each part as the backup identity, and stamps it.
    await reach(storeUrl, upload(source, seal, failure));
  } catch {
    return failed('backup run', failure.stage ?? 'store');
  }
  const record = { event: 'backup run', outcome: 'recorded', at, bytes: failure.bytes };
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
    return await runBackup({
      dump: () => pgDump(source),
      storeUrl,
      publicKey,
      heartbeat,
    });
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

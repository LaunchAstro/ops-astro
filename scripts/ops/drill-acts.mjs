// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's acts as the operator the gate admitted
// (restore-drill.mjs, S0-3d and S0-3e): the newest backup fetched from the
// store, the drill and its receipt, and the clean-host leg's export of a
// carried archive and record of its receipt brought back (carried-archive.mjs).
// restore-drill.mjs passes the drill itself in and re-exports each act.

import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { bound, stagingReach, value } from './backup-store-reach.mjs';
import { readCarried, readCarriedReceipt, writeCarried } from './carried-archive.mjs';
import { RESTORE_ROLE, recordCarriedDrill, recordDrill } from './drill-receipt.mjs';
import { recordDeployment } from './operator.ts';
import { holdOwed, noteOwed } from './stamp-owed.mjs';
import { stampedArchive } from './tested-restore.ts';

const HEX64 = /^[0-9a-f]{64}$/u;
// The store's part size (deploy/staging/backup-store.sql, backups.archive_parts).
const PART = 4 * 1024 * 1024;
const PART_LINE = /^(\d+)\|([0-9a-f]{64})\|((?:[0-9a-f]{2})+)$/u;
const same = (a, b) =>
  HEX64.test(a) && HEX64.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The store's header of the newest backup, as the restore identity (the store
 * logs the read), for `operator`: the store hands it out only to the login the
 * installation appointed as that person, in the operating business.
 */
async function latestHeader(storeUrl, reach, operator) {
  const line = await reach(
    storeUrl,
    `set role ${RESTORE_ROLE};\n` +
      bound(
        "select json_build_object('id', id, 'takenAt', taken_at, 'bytes', bytes, 'parts', parts, 'sha256', sha256)::text from backups.read_latest(nullif($1, '')::uuid, nullif($2, ''))",
        [operator?.personId ?? '', operator?.business ?? ''],
      ),
  );
  if (line === '') throw new Error('no backup');
  const header = JSON.parse(line);
  if (!Number.isInteger(header.parts) || header.parts < 1 || !HEX64.test(header.sha256)) {
    throw new Error('the store answered no archive');
  }
  return header;
}

/** The script that reads part `seq` of `header`'s archive: one line. */
const partScript = (header, seq) =>
  `set role ${RESTORE_ROLE};\nselect ${seq} || '|' || part_sha256 || '|' || encode(part, 'hex') from backups.read_part(${value(header.id, 'uuid')}, ${seq});\n`;

/**
 * The newest backup, read as the restore identity (the store logs the read),
 * part by part into `file` (made here, mode 600, never over a file), each
 * part checked against the digest the store took of it and the whole against
 * the digest the store recorded; nothing is held whole. A part is a reach of
 * its own, after the last has ended, so a gated reach asks between parts. On
 * any failure the file is removed. `operator` is the gate's person and
 * business, which the store checks against its own appointment first.
 */
export async function fetchLatest(storeUrl, file, reach = stagingReach, operator = undefined) {
  const header = await latestHeader(storeUrl, reach, operator);
  const fd = openSync(file, 'wx', 0o600);
  const whole = createHash('sha256');
  // One part's room, used for every part in turn.
  const room = Buffer.allocUnsafe(PART);
  let [next, bytes] = [0, 0];
  const onPart = (line) => {
    const [, seq, digest, hex = ''] = PART_LINE.exec(line) ?? [];
    const part = room.subarray(0, hex.length > 2 * PART ? 0 : room.write(hex, 'hex'));
    const own = createHash('sha256').update(part).digest('hex');
    if (Number(seq) !== next || part.length === 0 || !same(own, digest ?? '')) {
      throw new Error('a part of the archive is not the one the store took');
    }
    whole.update(part);
    writeSync(fd, part);
    [next, bytes] = [next + 1, bytes + part.length];
  };
  try {
    for (let seq = 0; seq < header.parts && next === seq; seq += 1)
      // oxlint-disable-next-line no-await-in-loop -- one part at a time, each ended before the next
      await reach(storeUrl, partScript(header, seq), onPart);
    if (
      next !== header.parts ||
      bytes !== header.bytes ||
      !same(whole.digest('hex'), header.sha256)
    ) {
      throw new Error('the archive does not match the digest the store recorded');
    }
  } catch (error) {
    closeSync(fd);
    unlinkSync(file);
    throw error;
  }
  closeSync(fd);
  const takenAt = new Date(header.takenAt).toISOString();
  return { archiveId: header.id, takenAt, sha256: header.sha256, bytes };
}

/**
 * `act` once a pass the store took is dated where the operations view reads
 * it (C55, migration 0070), through the gate (operator.ts). A failed drill, a
 * carried one still pending and a receipt the store refused stamp nothing.
 */
async function stampIfPassed(gate, act) {
  if (act.outcome !== 'passed' || act.lastTestedRestore === null) return act;
  try {
    // The date the stamp wrote is the one recorded, never the store's or a note's.
    return { ...act, lastTestedRestore: await gate.recordTestedRestore() };
  } catch {
    // The database's own message can name its host; the operator is told the step.
    throw new Error(
      'the drill passed and the store has its receipt, but the date of the last tested restore could not be written for the operations view',
    );
  }
}

/**
 * `--export`: the newest backup as the store handed it out, into `file` for a
 * drill on another host, with its time and digest beside it
 * (carried-archive.mjs). The key is never read here.
 */
export async function exportArchive({ gate, storeUrl, file, reach = stagingReach }) {
  const archive = await writeCarried(file, (into) =>
    fetchLatest(storeUrl, into, reach, gate.operator),
  );
  return await recordDeployment(gate, {
    action: 'archive exported',
    archiveTakenAt: archive.takenAt,
  });
}

/**
 * The drill as the operator the gate admitted runs it: the drill, then its
 * receipt in the store, then the operator's record. Returns the receipt. On
 * the machine a pass goes to the store as this operator's own act, with the
 * business, the id of the archive the drill fetched and the whole digest it
 * computed of it, bound and never printed; the store takes it only through
 * the store login the installation appointed as this person. Every receipt
 * names the store's own id for the archive the drill fetched or was carried.
 */
export async function drillAsOperator({
  gate,
  storeUrl,
  archiveFile,
  privateKey,
  scope,
  drill,
  reach = stagingReach,
}) {
  const carried = archiveFile !== undefined;
  let fetched = {};
  const {
    event: _event,
    at: _at,
    ...result
  } = await drill({
    fetchArchive: carried
      ? (into) => (fetched = readCarried(archiveFile, into))
      : async (into) => (fetched = await fetchLatest(storeUrl, into, reach, gate.operator)),
    privateKey,
    scope,
  });
  const empty = { stage: null, archiveTakenAt: null, tables: null, readAs: null };
  const act = {
    action: 'restore drill recorded',
    ...empty,
    ...result,
    archiveId: fetched.archiveId ?? null,
    ranOn: carried ? 'carried archive' : 'staging machine',
  };
  if (carried) {
    // Off the machine the store is out of reach: the receipt is kept and
    // printed, and `--record` takes it back into the store with the archive.
    // Until the operator records it there, it is not a pass.
    if (act.outcome === 'passed') act.outcome = 'pending';
    act.lastTestedRestore = null;
    return await recordDeployment(gate, act);
  }
  try {
    act.lastTestedRestore = await recordDrill(storeUrl, gate.operator.personId, act, reach, {
      business: gate.operator.business,
      archiveId: fetched.archiveId ?? null,
      digest: fetched.sha256 ?? null,
    });
  } catch {
    // The store's own message can name its host; the operator is told the step.
    throw new Error('the drill ran, but its receipt could not be written to the store');
  }
  return await recordDeployment(gate, await stampIfPassed(gate, act));
}

/**
 * `--record`: a carried drill's receipt, brought back by the operator who ran
 * it, in the business it ran in, with the archive it restored. The archive's
 * digest is computed here from the file itself and goes to the store as a
 * bound parameter, never printed, with the archive's id and the business.
 * The store takes it once, and a pass only as the appointed operator's own
 * act. What is recorded and returned is the outcome and the store's answer,
 * never the receipt's fields.
 */
export async function recordCarried({
  gate,
  storeUrl,
  receiptFile,
  archiveFile,
  reach = stagingReach,
}) {
  const carried = readCarriedReceipt(receiptFile, gate.operator);
  if (typeof archiveFile !== 'string' || archiveFile === '') {
    throw new Error('--record needs the archive the drill restored: --archive <file>');
  }
  const { archiveId, sha256: digest } = readCarried(archiveFile);
  // The receipt names the store's own id for the archive its drill restored:
  // another archive carried back in its place, even one taken at the same
  // time, is refused before the store is reached.
  if (carried.archiveId !== archiveId) {
    throw new Error(
      'the receipt names no archive, or another archive than the one carried back: bring back the archive its drill restored',
    );
  }
  const outcome = carried.outcome === 'pending' ? 'passed' : 'failed';
  // The store takes a receipt once: a pass whose stamp failed is noted beside
  // the receipt, and a re-run of --record holds the note and writes only the stamp.
  const owed = `${receiptFile}.stamp-owed`;
  const held = outcome === 'passed' ? holdOwed(owed, archiveId) : undefined;
  if (held) return await stampCarried(gate, owed, archiveId, held);
  let lastTestedRestore;
  try {
    lastTestedRestore = await recordCarriedDrill(
      storeUrl,
      carried.operator,
      { ...carried, outcome },
      { archiveId, digest, business: gate.operator.business },
      reach,
    );
  } catch {
    throw new Error(
      "the store did not take the receipt: it has it already, it never handed out that archive, with that digest, to this login inside the window, or this login is not the installation's appointed operator",
    );
  }
  if (outcome === 'passed' && lastTestedRestore !== null) {
    return await stampCarried(gate, owed, archiveId);
  }
  return await recordDeployment(gate, carriedAct(outcome, lastTestedRestore));
}

const carriedAct = (outcome, lastTestedRestore) => ({
  action: 'carried drill recorded',
  outcome,
  ranOn: 'carried archive',
  lastTestedRestore,
});

/**
 * A carried pass the store took, stamped once for its archive (tested-restore.ts),
 * so a run killed after the stamp committed is not dated again; the note (`held`)
 * is gone only once it is.
 */
async function stampCarried(gate, owed, archiveId, held) {
  const stamping = stampedArchive.run(archiveId, () =>
    stampIfPassed(gate, carriedAct('passed', 'owed')),
  );
  const act = await stamping.catch((error) => {
    if (held) renameSync(held, owed);
    else noteOwed(owed, archiveId, error);
    throw new Error(`${error.message}: re-run --record to write it`, { cause: error });
  });
  if (held) unlinkSync(held);
  return await recordDeployment(gate, act);
}

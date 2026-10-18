// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the drill's acts and the held grant their receipts and stamps are written under */
//
// The restore drill's acts as the operator the gate admitted
// (restore-drill.mjs, S0-3d and S0-3e): the newest backup fetched from the
// store, the drill and its receipt, and the clean-host leg's export of a
// carried archive and record of its receipt brought back (carried-archive.mjs).
// restore-drill.mjs passes the drill itself in and re-exports each act.

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { bound, param, stagingReach, value } from './backup-store-reach.mjs';
import { readCarried, readCarriedReceipt, writeCarried } from './carried-archive.mjs';
import { RESTORE_ROLE, recordCarriedDrill, recordDrill } from './drill-receipt.mjs';
import { recordDeployment } from './operator.ts';

const HEX64 = /^[0-9a-f]{64}$/u;
// The store's part size (deploy/staging/backup-store.sql, backups.archive_parts).
const PART = 4 * 1024 * 1024;
// A part as `read_part` hands it out, sealed under its own key, padded by at most a block.
const SEALED = PART + 16;
const PART_LINE = /^(\d+)\|([0-9a-f]{64})\|((?:[0-9a-f]{2})+)$/u;
const KEY_LINE = /^[0-9a-f]{64}$/u;
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
        `select json_build_object('id', id, 'takenAt', taken_at, 'bytes', bytes, 'parts', parts, 'sha256', sha256)::text from backups.read_latest(${param(1, 'uuid')}, ${param(2, 'text')})`,
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

/** The script that reads part `seq` of `header`'s archive, sealed under its own key: one line. */
const partScript = (header, seq) =>
  `set role ${RESTORE_ROLE};\nselect ${seq} || '|' || part_sha256 || '|' || encode(part, 'hex') from backups.read_part(${value(header.id, 'uuid')}, ${seq});\n`;

/** The script that has the store release that part's key, and log the part's read: one line. */
const releaseScript = (header, seq) =>
  `set role ${RESTORE_ROLE};\nselect encode(backups.release_part(${value(header.id, 'uuid')}, ${seq}), 'hex');\n`;

/** `sealed` opened with the key the store released for it (backup-store-upgrade-3.sql). */
function opened(sealed, key) {
  try {
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.alloc(16));
    return Buffer.concat([decipher.update(sealed), decipher.final()]);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * The newest backup, read as the restore identity (the store logs the read),
 * part by part into `file` (made here, mode 600, never over a file), each
 * part checked against the digest the store took of it and the whole against
 * the digest the store recorded; nothing is held whole. Each part takes two
 * reaches, each begun only once the one before it has ended: its read, which
 * the store answers sealed under a key of its own and does not log, then its
 * release, which hands out that key and logs the part's read. A gated reach
 * asks between them, so an operator stopped before the release gets nothing
 * they can open. On any failure the file is removed. `operator` is the gate's
 * person and business, which the store checks against its own appointment
 * first.
 */
export async function fetchLatest(storeUrl, file, reach = stagingReach, operator = undefined) {
  const header = await latestHeader(storeUrl, reach, operator);
  const fd = openSync(file, 'wx', 0o600);
  const whole = createHash('sha256');
  // One sealed part's room, used for every part in turn.
  const room = Buffer.allocUnsafe(SEALED);
  let [next, bytes] = [0, 0];
  const fetchPart = async (seq) => {
    const [, at, digest, hex = ''] =
      PART_LINE.exec(await reach(storeUrl, partScript(header, seq))) ?? [];
    const sealed = room.subarray(0, hex.length > 2 * SEALED ? 0 : room.write(hex, 'hex'));
    let part = Buffer.alloc(0);
    await reach(storeUrl, releaseScript(header, seq), (key) => {
      if (KEY_LINE.test(key) && sealed.length > 0) part = opened(sealed, key);
      const own = createHash('sha256').update(part).digest('hex');
      if (Number(at) !== seq || part.length === 0 || !same(own, digest ?? '')) {
        throw new Error('a part of the archive is not the one the store took');
      }
      whole.update(part);
      writeSync(fd, part);
      [next, bytes] = [next + 1, bytes + part.length];
    });
  };
  try {
    for (let seq = 0; seq < header.parts && next === seq; seq += 1)
      // oxlint-disable-next-line no-await-in-loop -- one part at a time, each ended before the next
      await fetchPart(seq);
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

/** A gate that can hold the operator's grant and ask again under it, or a refusal before the store. */
function holding(gate) {
  if (typeof gate.holdingGrant !== 'function' || typeof gate.stillOperator !== 'function') {
    throw new TypeError(
      'the operator gate cannot hold the grant: it needs holdingGrant and stillOperator, so nothing was written',
    );
  }
  return gate;
}

/**
 * `work`, the store's receipt and the stamp, as the operator's attestation:
 * with their `operations:manage` grant held (operator.ts, `holdingGrant`) and
 * the gate asked again under that hold first. That answer is the instant the
 * operator attests. A revocation committed before it refuses here, with
 * nothing written. What is held is the person's own `operations:manage` grant
 * rows (`holdingGrant`), so revoking that grant after it waits until `work` is
 * done. A change the hold does not lock (a grant held through their acting
 * identity or a parent grant, the membership, a sign-out, the token's own
 * expiry) is ordered after the act, as on the read path.
 */
async function attested(gate, work) {
  return await holding(gate).holdingGrant(async (release) => {
    try {
      await gate.stillOperator();
    } catch {
      // The hold ends as this returns; the gate's own words can name its database.
      throw new Error(
        'the drill ran, but the operator no longer holds operations:manage, so no receipt was written',
      );
    }
    try {
      return await work();
    } finally {
      release();
    }
  });
}

/** On the machine: the drill's receipt in the store, then the stamp of a pass the store took. */
async function receiptOnMachine(gate, storeUrl, act, fetched, reach) {
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
  return await stampIfPassed(gate, act);
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
  // On the machine the receipt and the stamp need the held grant: a gate that
  // cannot hold it is refused before the store is reached at all.
  if (!carried) holding(gate);
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
  // The receipt and the stamp under the held grant; the record after its release.
  const done = await attested(gate, () => receiptOnMachine(gate, storeUrl, act, fetched, reach));
  return await recordDeployment(gate, done);
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
  holding(gate);
  const carried = readCarriedReceipt(receiptFile, gate.operator);
  if (typeof archiveFile !== 'string' || archiveFile === '') {
    throw new Error('--record needs the archive the drill restored: --archive <file>');
  }
  const { archiveId, sha256: digest, takenAt } = readCarried(archiveFile);
  // The receipt names the store's own id for the archive its drill restored,
  // or none if it failed before reading one: another archive carried back in
  // its place, even one taken at the same time, is refused before the store.
  if (carried.archiveId !== null && carried.archiveId !== archiveId) {
    throw new Error(
      'the receipt is of another archive than the one carried back: bring back the archive its drill restored',
    );
  }
  const outcome = carried.outcome === 'pending' ? 'passed' : 'failed';
  // The store takes a receipt once: a pass whose stamp failed is noted beside
  // the receipt, and a re-run of --record writes only the stamp.
  const owed = `${receiptFile}.stamp-owed`;
  if (outcome === 'passed' && stampOwed(owed, archiveId)) {
    return await recordDeployment(gate, await attested(gate, () => stampCarried(gate, owed)));
  }
  const receipt = { ...carried, outcome, archiveTakenAt: carried.archiveTakenAt ?? takenAt };
  const binding = { archiveId, digest, business: gate.operator.business };
  // The receipt and the stamp under the held grant; the record after its release.
  const act = await attested(gate, () =>
    receiptCarried({ gate, storeUrl, receipt, binding, owed, reach }),
  );
  return await recordDeployment(gate, act);
}

/** A carried drill's receipt into the store, then the stamp of a pass the store took. */
async function receiptCarried({ gate, storeUrl, receipt, binding, owed, reach }) {
  let lastTestedRestore;
  try {
    lastTestedRestore = await recordCarriedDrill(
      storeUrl,
      receipt.operator,
      receipt,
      binding,
      reach,
    );
  } catch {
    throw new Error(
      "the store did not take the receipt: it has it already, it never handed out that archive, with that digest, to this login inside the window, or this login is not the installation's appointed operator",
    );
  }
  if (receipt.outcome === 'passed' && lastTestedRestore !== null) {
    return await stampCarried(gate, owed, binding.archiveId);
  }
  return carriedAct(receipt.outcome, lastTestedRestore);
}

const carriedAct = (outcome, lastTestedRestore) => ({
  action: 'carried drill recorded',
  outcome,
  ranOn: 'carried archive',
  lastTestedRestore,
});

/** A carried pass the store took, stamped first; a note only if that fails (`archiveId` given). */
async function stampCarried(gate, owed, archiveId) {
  const act = await stampIfPassed(gate, carriedAct('passed', 'owed')).catch((error) => {
    if (archiveId !== undefined) noteOwed(owed, archiveId, error);
    throw new Error(`${error.message}: re-run --record to write it`, { cause: error });
  });
  // A re-run's stamp is written, so its note goes.
  if (archiveId === undefined) unlinkSync(owed);
  return act;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Notes beside the receipt that the store took `archiveId`'s pass and its stamp is owed. */
function noteOwed(owed, archiveId, stampError) {
  try {
    writeFileSync(owed, JSON.stringify({ archiveId }), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Error(
      `${stampError.message}; and the note to finish it, ${owed}, could not be written either, ` +
        'so a re-run of --record cannot stamp this pass (the store has its receipt): ' +
        'run select ops.record_tested_restore() with DATABASE_ADMIN_URL',
      { cause: stampError },
    );
  }
}

/** Whether the store holds `archiveId`'s pass with its stamp still owed, from the note. */
function stampOwed(owed, archiveId) {
  if (!existsSync(owed)) return false;
  let noted;
  try {
    noted = JSON.parse(readFileSync(owed, 'utf8'));
  } catch {}
  if (typeof noted?.archiveId !== 'string' || !UUID.test(noted.archiveId)) {
    throw new Error(
      `the stamp-owed note ${owed} is not one --record wrote: remove it only if the store has not taken this receipt`,
    );
  }
  if (noted.archiveId !== archiveId) throw new Error('the stamp owed is of another archive');
  return true;
}

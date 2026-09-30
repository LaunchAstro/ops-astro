// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's acts as the operator the gate admitted
// (restore-drill.mjs, S0-3d and S0-3e): the newest backup fetched from the
// store, the drill and its receipt, and the clean-host leg's export of a
// carried archive and record of its receipt brought back (carried-archive.mjs).
// restore-drill.mjs passes the drill itself in and re-exports each act.

import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { bound, stagingReach, value } from './backup-store-reach.mjs';
import { readCarried, readCarriedReceipt, writeCarried } from './carried-archive.mjs';
import { RESTORE_ROLE, recordCarriedDrill, recordDrill } from './drill-receipt.mjs';
import { recordDeployment } from './operator.ts';

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

/** The script that reads every part of `header`'s archive, one line per part. */
function* partsScript(header) {
  yield `set role ${RESTORE_ROLE};\n`;
  for (let seq = 0; seq < header.parts; seq += 1) {
    yield `select ${seq} || '|' || part_sha256 || '|' || encode(part, 'hex') from backups.read_part(${value(header.id, 'uuid')}, ${seq});\n`;
  }
}

/**
 * The newest backup, read as the restore identity (the store logs the read),
 * part by part into `file` (made here, mode 600, never over a file), each
 * part checked against the digest the store took of it and the whole against
 * the digest the store recorded; nothing is held whole. On any failure the
 * file is removed. `operator` is the gate's person and business, which the
 * store checks against its own appointment before it hands out anything.
 */
export async function fetchLatest(storeUrl, file, reach = stagingReach, operator = undefined) {
  const header = await latestHeader(storeUrl, reach, operator);
  const fd = openSync(file, 'wx', 0o600);
  const whole = createHash('sha256');
  // One part's room, used for every part in turn.
  const room = Buffer.allocUnsafe(PART);
  let [next, bytes] = [0, 0];
  try {
    await reach(storeUrl, partsScript(header), (line) => {
      const [, seq, digest, hex = ''] = PART_LINE.exec(line) ?? [];
      const part = room.subarray(0, hex.length > 2 * PART ? 0 : room.write(hex, 'hex'));
      const own = createHash('sha256').update(part).digest('hex');
      if (Number(seq) !== next || part.length === 0 || !same(own, digest ?? '')) {
        throw new Error('a part of the archive is not the one the store took');
      }
      whole.update(part);
      writeSync(fd, part);
      [next, bytes] = [next + 1, bytes + part.length];
    });
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
  return await recordDeployment(gate, act);
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
      'the receipt is of another archive than the one carried back: bring back the archive its drill restored',
    );
  }
  const outcome = carried.outcome === 'pending' ? 'passed' : 'failed';
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
  return await recordDeployment(gate, {
    action: 'carried drill recorded',
    outcome,
    ranOn: 'carried archive',
    lastTestedRestore,
  });
}

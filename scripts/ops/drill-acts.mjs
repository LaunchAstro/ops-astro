// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's acts as the operator the gate admitted
// (restore-drill.mjs, S0-3d and S0-3e): the newest backup fetched from the
// store, the drill and its receipt, and the clean-host leg's export of a
// carried archive and record of its receipt brought back (carried-archive.mjs).
// restore-drill.mjs passes the drill itself in and re-exports each act.

import { stagingReach } from './backup-store-reach.mjs';
import { readCarried, readCarriedReceipt, writeCarried } from './carried-archive.mjs';
import { RESTORE_ROLE, recordDrill } from './drill-receipt.mjs';
import { recordDeployment } from './operator.ts';

/**
 * The newest backup, read as the restore identity (the store logs the read),
 * with the digest the store recorded when it took it.
 */
export async function fetchLatest(storeUrl, reach = stagingReach) {
  const latest = await reach(
    storeUrl,
    `set role ${RESTORE_ROLE};
select json_build_object('takenAt', taken_at, 'sha256', sha256, 'body', encode(body, 'hex'))::text
  from backups.read_latest();
`,
  );
  if (latest === '') throw new Error('no backup');
  const row = JSON.parse(latest);
  return {
    takenAt: new Date(row.takenAt).toISOString(),
    sha256: row.sha256,
    body: Buffer.from(row.body, 'hex'),
  };
}

/**
 * `--export`: the newest backup as the store handed it out, into `file` for a
 * drill on another host (carried-archive.mjs). The key is never read here.
 */
export async function exportArchive({ gate, storeUrl, file, reach = stagingReach }) {
  const archive = await fetchLatest(storeUrl, reach);
  writeCarried(file, archive);
  return await recordDeployment(gate, {
    action: 'archive exported',
    archiveTakenAt: archive.takenAt,
  });
}

/**
 * The drill as the operator the gate admitted runs it: the drill, then its
 * receipt in the store, then the operator's record. Returns the receipt.
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
  const {
    event: _event,
    at: _at,
    ...result
  } = await drill({
    fetchArchive: carried ? () => readCarried(archiveFile) : () => fetchLatest(storeUrl, reach),
    privateKey,
    scope,
  });
  const empty = { stage: null, archiveTakenAt: null, tables: null, readAs: null };
  const act = {
    action: 'restore drill recorded',
    ...empty,
    ...result,
    ranOn: carried ? 'carried archive' : 'staging machine',
  };
  if (carried) {
    // Off the machine the store is out of reach: the receipt is kept and
    // printed, and `--record` takes it back into the store.
    act.lastTestedRestore = null;
    return await recordDeployment(gate, act);
  }
  try {
    act.lastTestedRestore = await recordDrill(storeUrl, gate.operator.personId, act, reach);
  } catch {
    // The store's own message can name its host; the operator is told the step.
    throw new Error('the drill ran, but its receipt could not be written to the store');
  }
  return await recordDeployment(gate, act);
}

/**
 * `--record`: a carried drill's receipt, brought back by the operator who ran
 * it, into the store. The store takes it once, against its own logged read.
 */
export async function recordCarried({ gate, storeUrl, receiptFile, reach = stagingReach }) {
  const receipt = readCarriedReceipt(receiptFile, gate.operator.personId);
  let lastTestedRestore;
  try {
    lastTestedRestore = await recordDrill(storeUrl, receipt.operator, receipt, reach, true);
  } catch {
    throw new Error(
      'the store did not take the receipt: it has it already, or it never handed out that archive to this login inside the window',
    );
  }
  return await recordDeployment(gate, {
    ...receipt,
    action: 'carried drill recorded',
    lastTestedRestore,
  });
}

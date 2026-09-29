// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's receipt (scripts/ops/restore-drill.mjs, S0-3d): the
// fields a receipt may carry, and the write that puts it in the backup store
// as the restore identity.

import postgres from 'postgres';

export const RESTORE_ROLE = 'ops_astro_backup_restore';

/** The fields every drill receipt carries, and no other: no record data, key, credential, fingerprint or path. */
export const RECEIPT_FIELDS = [
  'action',
  'outcome',
  'stage',
  'at',
  'target',
  'productionMajor',
  'sourceMajor',
  'targetMajor',
  'archiveTakenAt',
  'tables',
  'readAs',
  'timings',
  'lastTestedRestore',
  'business',
  'operator',
];

/**
 * The drill's receipt in the store, as the restore identity: the store stamps
 * the time, and a passed drill's time is the date of the last tested restore.
 */
export async function recordDrill(storeUrl, operator, record) {
  const sql = postgres(storeUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${RESTORE_ROLE}`);
      const [row] = await tx`select backups.record_drill(
        ${record.outcome}, ${record.stage ?? null}, ${operator}, ${record.archiveTakenAt ?? null},
        ${record.productionMajor}, ${record.sourceMajor}, ${record.targetMajor},
        ${record.tables ?? null}, ${sql.json(record.timings)}) as at`;
      return row.at === null ? null : row.at.toISOString();
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

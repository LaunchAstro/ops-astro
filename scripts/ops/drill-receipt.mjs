// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's receipt (scripts/ops/restore-drill.mjs, S0-3d): the
// fields a receipt may carry, and the write that puts it in the backup store
// as the restore identity, through psql on staging's network
// (backup-store-reach.mjs).

import { bound, stagingReach, value } from './backup-store-reach.mjs';

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
  'ranOn',
];

/**
 * The drill's receipt in the store, as the restore identity: the store stamps
 * the time, and a passed drill's time is the date of the last tested restore.
 */
export async function recordDrill(storeUrl, operator, record, reach = stagingReach) {
  const args = [
    value(record.outcome, 'text'),
    value(record.stage ?? null, 'text'),
    value(operator, 'uuid'),
    value(record.archiveTakenAt ?? null, 'timestamptz'),
    value(record.productionMajor, 'integer'),
    value(record.sourceMajor ?? null, 'integer'),
    value(record.targetMajor ?? null, 'integer'),
    value(record.tables ?? null, 'integer'),
    value(record.timings, 'jsonb'),
  ];
  const at = await reach(
    storeUrl,
    `set role ${RESTORE_ROLE};\nselect to_json(backups.record_drill(${args.join(', ')}))::text;\n`,
  );
  return at === '' ? null : new Date(JSON.parse(at)).toISOString();
}

/**
 * A carried drill's receipt, brought back (`--record`), through
 * `backups.record_carried_drill`: taken once, only against a read of that
 * archive (`archiveId`, the store's own id) the store logged for this login,
 * only for the digest of the file
 * carried back (`digest`) and, for a pass, only with the restore challenge the
 * drill read back from the database it restored (`challenge`). Every value
 * goes as a bound parameter; the digest and the challenge are never printed.
 */
export async function recordCarriedDrill(
  storeUrl,
  operator,
  record,
  { archiveId, digest, challenge },
  reach = stagingReach,
) {
  const types = ['text', 'text', 'uuid', 'timestamptz', 'integer', 'integer', 'integer', 'integer'];
  const casts = [...types, 'jsonb', 'text', 'text', 'uuid'].map(
    (type, i) => `nullif($${i + 1}, '')::${type}`,
  );
  const at = await reach(
    storeUrl,
    `set role ${RESTORE_ROLE};\n` +
      bound(`select to_json(backups.record_carried_drill(${casts.join(', ')}))::text`, [
        record.outcome,
        record.stage,
        operator,
        record.archiveTakenAt,
        record.productionMajor,
        record.sourceMajor,
        record.targetMajor,
        record.tables,
        record.timings,
        digest,
        challenge,
        archiveId,
      ]),
  );
  return at === '' ? null : new Date(JSON.parse(at)).toISOString();
}

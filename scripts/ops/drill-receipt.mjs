// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's receipt (scripts/ops/restore-drill.mjs, S0-3d): the
// fields a receipt may carry, and the writes that put it in the backup store
// as the restore identity, through psql on staging's network
// (backup-store-reach.mjs), every value bound.

import { bound, stagingReach } from './backup-store-reach.mjs';

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
  'archiveId',
  'tables',
  'readAs',
  'timings',
  'lastTestedRestore',
  'business',
  'operator',
  'ranOn',
];

const CASTS = [
  'text',
  'text',
  'uuid',
  'timestamptz',
  'integer',
  'integer',
  'integer',
  'integer',
  'jsonb',
];

/** One store call of `fn` with `record`'s fields and then `more`, every value bound. */
async function recordThrough(fn, storeUrl, operator, record, more, reach) {
  const casts = [...CASTS, ...more.map(([type]) => type)].map(
    (type, i) => `nullif($${i + 1}, '')::${type}`,
  );
  const at = await reach(
    storeUrl,
    `set role ${RESTORE_ROLE};\n` +
      bound(`select to_json(backups.${fn}(${casts.join(', ')}))::text`, [
        record.outcome,
        record.stage,
        operator,
        record.archiveTakenAt,
        record.productionMajor,
        record.sourceMajor,
        record.targetMajor,
        record.tables,
        record.timings,
        ...more.map(([, v]) => v),
      ]),
  );
  return at === '' ? null : new Date(JSON.parse(at)).toISOString();
}

/**
 * A drill on the machine, in the store, through `backups.record_drill`: the
 * store stamps the time, and a passed drill's time is the date of the last
 * tested restore. A pass is the appointed operator's own act: the store takes
 * it only through the store login the installation appointed as `operator`,
 * in the operating business (`business`), for the archive this login read
 * (`archiveId`) with the whole digest the drill computed of what it fetched
 * (`digest`). Every value goes as a bound parameter; the digest is never
 * printed.
 */
export async function recordDrill(
  storeUrl,
  operator,
  record,
  reach = stagingReach,
  { business = null, archiveId = null, digest = null } = {},
) {
  const more = [
    ['text', business],
    ['uuid', archiveId],
    ['text', digest],
  ];
  return await recordThrough('record_drill', storeUrl, operator, record, more, reach);
}

/**
 * A carried drill's receipt, brought back (`--record`), through
 * `backups.record_carried_drill`: taken once, only against a read of that
 * archive (`archiveId`, the store's own id) the store logged for this login,
 * only for the digest of the file carried back (`digest`), and a pass only as
 * the appointed operator's own act in the operating business (`business`).
 * Every value goes as a bound parameter; the digest is never printed.
 */
export async function recordCarriedDrill(
  storeUrl,
  operator,
  record,
  { archiveId, digest, business },
  reach = stagingReach,
) {
  const more = [
    ['text', digest],
    ['uuid', archiveId],
    ['text', business],
  ];
  return await recordThrough('record_carried_drill', storeUrl, operator, record, more, reach);
}

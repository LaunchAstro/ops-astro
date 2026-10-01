// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3d drill receipts the backup store suites record: one passed drill,
// one failed, the operator who ran them, and the store call that records one
// as the admin would. The store itself is backup-identity.fixture.ts.

import { randomUUID } from 'node:crypto';

/** A drill receipt as the store takes it (S0-3d). */
export type DrillRecord = {
  readonly outcome: string;
  readonly stage: string | null;
  readonly target: string;
  readonly productionMajor: number;
  readonly sourceMajor: number | null;
  readonly targetMajor: number;
  readonly archiveTakenAt: string;
  readonly tables: number | null;
  readonly readAs: string | null;
  readonly timings: {
    readonly fetch: number;
    readonly open: number;
    readonly start: number;
    readonly restore: number;
    readonly check: number;
  };
};

export const operator: string = randomUUID();

export const passed: DrillRecord = {
  outcome: 'passed',
  stage: null,
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: '2026-09-29T02:00:00.000Z',
  tables: 12,
  readAs: 'ops_astro_app',
  timings: { fetch: 10, open: 20, start: 900, restore: 400, check: 30 },
};

export const failed: DrillRecord = {
  ...passed,
  outcome: 'failed',
  stage: 'restore',
  sourceMajor: null,
  tables: null,
  readAs: null,
};

/** What a pass on the machine binds: the archive this login read, its time and digest, and the business. */
export type Binding = {
  readonly archiveTakenAt: string;
  readonly business: string;
  readonly archiveId: string;
  readonly sha256: string;
};

/**
 * The store call that records `r` as the admin would, as the drill sends it:
 * with `bound`, a pass's business, archive and digest after its fields.
 */
export const call = (r: DrillRecord, bound?: Binding): [string, unknown[]] => {
  const fields = [
    r.outcome,
    r.stage,
    operator,
    bound?.archiveTakenAt ?? r.archiveTakenAt,
    r.productionMajor,
    r.sourceMajor,
    r.targetMajor,
    r.tables,
    r.timings,
  ];
  if (bound === undefined) {
    return [
      'select backups.record_drill($1, $2, $3, $4, $5, $6, $7, $8, $9)::text as last',
      fields,
    ];
  }
  return [
    'select backups.record_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)::text as last',
    [...fields, bound.business, bound.archiveId, bound.sha256],
  ];
};

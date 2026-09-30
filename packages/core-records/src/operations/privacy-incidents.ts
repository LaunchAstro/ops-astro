// SPDX-License-Identifier: AGPL-3.0-only
//
// The privacy incident record (C55, SP-24, migration 0048): what the breach
// runbook opens on day 0. The words describe people and what happened to
// their information, so this module is their only reader and writer, and the
// command that records one audits a digest of the act, never the words.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

/** The kinds of information an incident can involve, as the runbook names them. */
export const INFORMATION_KINDS = [
  'contact',
  'identity',
  'financial',
  'health',
  'credentials',
  'client-files',
  'other',
] as const;

export type InformationKind = (typeof INFORMATION_KINDS)[number];

export interface PrivacyIncidentFacts {
  readonly whatHappened: string;
  /** Day 0: when there were first grounds to suspect it. */
  readonly foundAt: Date;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly InformationKind[];
}

export interface PrivacyIncident extends PrivacyIncidentFacts {
  readonly id: string;
  /** Day 0 plus 30 days: the runbook's assessment limit. */
  readonly assessBy: Date;
  /** Still open past `assessBy`, judged on the database's clock (C81 breach drill). */
  readonly overdue: boolean;
  readonly status: 'open' | 'closed';
  readonly recordedAt: Date;
  readonly recordedByActorId: string;
}

interface IncidentRow {
  readonly id: string;
  readonly what_happened: string;
  readonly found_at: Date;
  readonly found_by: string;
  readonly affected: string;
  readonly information_kinds: readonly InformationKind[];
  readonly overdue: boolean;
  readonly status: 'open' | 'closed';
  readonly recorded_at: Date;
  readonly recorded_by_actor: string;
}

/** The runbook's assessment limit: 30 calendar days from day 0. */
const ASSESSMENT_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// `overdue` is the database's judgement, on its own clock, of the same limit
// as `assessBy` (720 hours is ASSESSMENT_DAYS_MS): no server clock decides it.
const COLUMNS = `id, what_happened, found_at, found_by, affected, information_kinds,
  status = 'open' and now() > found_at + interval '720 hours' as overdue,
  status, recorded_at, recorded_by_actor`;

const shaped = (row: IncidentRow): PrivacyIncident => ({
  id: row.id,
  whatHappened: row.what_happened,
  foundAt: row.found_at,
  foundBy: row.found_by,
  affected: row.affected,
  informationKinds: row.information_kinds,
  assessBy: new Date(row.found_at.getTime() + ASSESSMENT_DAYS_MS),
  overdue: row.overdue,
  status: row.status,
  recordedAt: row.recorded_at,
  recordedByActorId: row.recorded_by_actor,
});

/** Open a privacy incident record in the serving transaction. */
export async function recordPrivacyIncident(
  tx: TenantQuery,
  facts: PrivacyIncidentFacts,
  actorId: string,
): Promise<PrivacyIncident> {
  const rows = await tx.query<IncidentRow>(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds,
        recorded_by_actor)
     values ($1, $2, $3, $4, $5, $6, $7::text[], $8)
     returning ${COLUMNS}`,
    [
      tx.businessId,
      randomUUID(),
      facts.whatHappened,
      facts.foundAt,
      facts.foundBy,
      facts.affected,
      facts.informationKinds,
      actorId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('recordPrivacyIncident: the insert returned no row');
  return shaped(row);
}

/** This business's incidents, the most recently found first, at most `limit`. */
export async function readPrivacyIncidents(
  tx: TenantQuery,
  limit = 200,
): Promise<readonly PrivacyIncident[]> {
  const rows = await tx.query<IncidentRow>(
    `select ${COLUMNS} from public.privacy_incidents
      where business_id = $1
      order by found_at desc, id
      limit $2`,
    [tx.businessId, limit],
  );
  return rows.map((row) => shaped(row));
}

/** One of this business's incidents by id, or `undefined` when it has none such. */
export async function readPrivacyIncident(
  tx: TenantQuery,
  id: string,
): Promise<PrivacyIncident | undefined> {
  const rows = await tx.query<IncidentRow>(
    `select ${COLUMNS} from public.privacy_incidents where business_id = $1 and id = $2`,
    [tx.businessId, id],
  );
  const row = rows[0];
  return row === undefined ? undefined : shaped(row);
}

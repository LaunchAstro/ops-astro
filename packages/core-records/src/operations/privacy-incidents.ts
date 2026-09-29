// SPDX-License-Identifier: AGPL-3.0-only
//
// The privacy incident record (C55, SP-24, migration 0033): what the breach
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
  readonly status: 'open' | 'closed';
  readonly recorded_at: Date;
  readonly recorded_by_actor: string;
}

const COLUMNS = `id, what_happened, found_at, found_by, affected, information_kinds,
  status, recorded_at, recorded_by_actor`;

/** The runbook's assessment limit: 30 calendar days from day 0. */
const ASSESSMENT_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const shaped = (row: IncidentRow): PrivacyIncident => ({
  id: row.id,
  whatHappened: row.what_happened,
  foundAt: row.found_at,
  foundBy: row.found_by,
  affected: row.affected,
  informationKinds: row.information_kinds,
  assessBy: new Date(row.found_at.getTime() + ASSESSMENT_DAYS_MS),
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
  return rows.map(shaped);
}

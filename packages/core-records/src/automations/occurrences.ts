// SPDX-License-Identifier: AGPL-3.0-only
//
// Occurrences (C33, U36; migration 0046): each due schedule time or matching
// event, written once. The database's uniqueness on the activation and its
// due time or event id holds that, so a claimer that races another commits
// one row and learns the other's, never a second.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  ACTIVATION_COLUMNS,
  activationOf,
  type ActivationDbRow,
  type ActivationMode,
} from './automations.ts';

export type OccurrenceOutcome = 'started' | 'activation_off' | 'no_standing_approval' | 'approved';

export interface OccurrenceRow {
  readonly id: string;
  readonly activationId: string;
  readonly versionId: string;
  readonly dueAt: Date | null;
  readonly eventId: string | null;
  readonly outcome: OccurrenceOutcome;
  readonly runId: string | null;
}

interface OccurrenceDbRow {
  readonly id: string;
  readonly activation_id: string;
  readonly version_id: string;
  readonly due_at: Date | null;
  readonly event_id: string | null;
  readonly outcome: OccurrenceOutcome;
  readonly run_id: string | null;
}

const OCCURRENCE_COLUMNS = 'id, activation_id, version_id, due_at, event_id, outcome, run_id';

const occurrenceOf = (row: OccurrenceDbRow): OccurrenceRow => ({
  id: row.id,
  activationId: row.activation_id,
  versionId: row.version_id,
  dueAt: row.due_at,
  eventId: row.event_id,
  outcome: row.outcome,
  runId: row.run_id,
});

export type OccurrenceCause = { readonly dueAt: Date } | { readonly eventId: string };

export type OccurrenceClaim =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_firing'; readonly mode: ActivationMode }
  | { readonly kind: 'claimed' | 'replayed'; readonly occurrence: OccurrenceRow };

/**
 * Writes the occurrence for one due time or one event, once. Called by the
 * scheduler and the event intake under the worker lease (AW-01), never by a
 * person's grant. The activation is share-locked, so a person's change waits
 * for the claim and the claim sees the setting it records.
 *
 * A second claim of the same cause, whether a replayed event, a restarted
 * scheduler or a racing one, commits nothing and answers `replayed` with the
 * first occurrence. No run starts here: an occurrence on an activation that is
 * on, under a standing approval that is not revoked (C52-A), is `approved`
 * and names that approval, and dispatch rechecks it before any run; every
 * other occurrence records why it will not start one.
 */
export async function claimOccurrence(
  tx: TenantQuery,
  activationId: string,
  cause: OccurrenceCause,
): Promise<OccurrenceClaim> {
  const found = await tx.query<ActivationDbRow & { readonly standing: string | null }>(
    `select ${ACTIVATION_COLUMNS},
            (select s.id from public.standing_approvals s
              where s.id = activations.approval_id
                and not exists (select 1 from public.standing_approval_revocations r
                                 where r.approval_id = s.id)) as standing
       from public.activations where id = $1 for share`,
    [activationId],
  );
  if (found[0] === undefined) return { kind: 'unknown' };
  const activation = activationOf(found[0]);
  const scheduled = 'dueAt' in cause;
  if (activation.mode !== (scheduled ? 'scheduled' : 'event')) {
    return { kind: 'not_firing', mode: activation.mode };
  }
  const standing = found[0].standing;
  let outcome: OccurrenceOutcome = 'activation_off';
  if (activation.enabled) outcome = standing === null ? 'no_standing_approval' : 'approved';
  const approvalId = outcome === 'approved' ? standing : null;
  const dueAt = scheduled ? cause.dueAt : null;
  const eventId = scheduled ? null : cause.eventId;
  const inserted = await tx.query<OccurrenceDbRow>(
    `insert into public.activation_occurrences
       (business_id, id, activation_id, version_id, due_at, event_id, outcome, approval_id)
     values ((select public.app_business_id()), $1, $2, $3, $4, $5, $6, $7)
     on conflict do nothing
     returning ${OCCURRENCE_COLUMNS}`,
    [randomUUID(), activation.id, activation.versionId, dueAt, eventId, outcome, approvalId],
  );
  if (inserted[0] !== undefined) return { kind: 'claimed', occurrence: occurrenceOf(inserted[0]) };
  const first = await tx.query<OccurrenceDbRow>(
    `select ${OCCURRENCE_COLUMNS} from public.activation_occurrences
      where activation_id = $1 and (due_at = $2 or event_id = $3)`,
    [activation.id, dueAt, eventId],
  );
  if (first[0] === undefined)
    throw new Error('claimOccurrence: a conflicting occurrence is not visible');
  return { kind: 'replayed', occurrence: occurrenceOf(first[0]) };
}

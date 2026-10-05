// SPDX-License-Identifier: AGPL-3.0-only
//
// Occurrences (C33, U36; migration 20261004091552): each due schedule time or matching
// event, written once. The database's uniqueness on the activation and its
// due time or event id holds that, so a claimer that races another commits
// one row and learns the other's, never a second. An occurrence under a
// standing approval (C52-A, migration 20261005193201) names it. C33's rates
// and intake bound (migration 20261005203620) are AW-01's durable limit.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { hasRoom, type DurableLimit } from '../tenancy/limit.ts';
import { readStandingApproval } from './approvals.ts';
import {
  ACTIVATION_COLUMNS,
  activationOf,
  type ActivationDbRow,
  type ActivationMode,
} from './automations.ts';

export type OccurrenceOutcome =
  | 'started'
  | 'activation_off'
  | 'no_standing_approval'
  | 'approved'
  | 'over_activation_rate'
  | 'over_business_rate'
  | 'over_intake_bound';

/**
 * C33's limits on firing (#483 point 4), the reviewed defaults, set here and
 * changed only by a reviewed change. Each rate counts a rolling 60 minutes of
 * the occurrence records; the ceiling and the queue count what is waiting now.
 */
export const FIRING_LIMITS = {
  /** One a minute covers the shortest schedule and a normal event stream. */
  activationPerHour: 60,
  /** Ten busy automations without one business crowding the shared worker. */
  businessPerHour: 600,
  /** Activation runs in flight per business: one agency's automations at once. */
  runsInFlight: 5,
  /** Approved events waiting for their run per business: about 90 minutes at the business rate. */
  eventQueue: 1000,
} as const;

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

/**
 * A rate's count: this business's occurrences let through in the last hour,
 * read under its lock. The hour ends at this statement's time, after the lock
 * wait, never the transaction's start; the claim stamps its row the same way.
 */
function firedLastHour(name: string, limit: number, activationId: string | null): DurableLimit {
  return {
    name,
    limit,
    async count(tx) {
      const rows = await tx.query<{ readonly n: number }>(
        `select count(*)::int as n from public.activation_occurrences
          where business_id = $1 and outcome in ('approved', 'started')
            and recorded_at > statement_timestamp() - interval '60 minutes'
            and ($2::uuid is null or activation_id = $2)`,
        [tx.businessId, activationId],
      );
      return rows[0]?.n ?? 0;
    },
  };
}

/**
 * `approved` while both rates have room, else the rate it is over. The
 * activation's lock, then the business's, always in that order, each held to
 * commit so the occurrence is written before the next claimer counts.
 */
async function withinRates(tx: TenantQuery, activationId: string): Promise<OccurrenceOutcome> {
  const own = firedLastHour(
    `c33.activation.${activationId}`,
    FIRING_LIMITS.activationPerHour,
    activationId,
  );
  if (!(await hasRoom(tx, [own]))) return 'over_activation_rate';
  const business = firedLastHour('c33.business', FIRING_LIMITS.businessPerHour, null);
  if (!(await hasRoom(tx, [business]))) return 'over_business_rate';
  return 'approved';
}

/** An occurrence `o` that is approved and has no dispatch yet. */
const NOT_DISPATCHED = `o.outcome = 'approved'
  and not exists (select 1 from public.occurrence_dispatches d
                   where d.business_id = o.business_id and d.occurrence_id = o.id)`;

/** The intake queue: this business's approved events whose run is not yet dispatched. */
const eventQueue: DurableLimit = {
  name: 'c33.intake',
  limit: FIRING_LIMITS.eventQueue,
  async count(tx) {
    const rows = await tx.query<{ readonly n: number }>(
      `select count(*)::int as n from public.activation_occurrences o
        where o.business_id = $1 and o.event_id is not null and ${NOT_DISPATCHED}`,
      [tx.businessId],
    );
    return rows[0]?.n ?? 0;
  },
};

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
 * and names that approval, and dispatch (`dispatch.ts`) rechecks it under the
 * activation's lock before any run; every other occurrence records why it
 * will not start one. An approved occurrence past either hourly rate is
 * recorded with the rate it is over; an event past the business's intake
 * queue is recorded `over_intake_bound`, never dropped unseen. The queue's
 * lock comes before the rates' locks.
 */
export async function claimOccurrence(
  tx: TenantQuery,
  activationId: string,
  cause: OccurrenceCause,
): Promise<OccurrenceClaim> {
  const found = await tx.query<ActivationDbRow>(
    `select ${ACTIVATION_COLUMNS} from public.activations
      where business_id = $1 and id = $2 for share`,
    [tx.businessId, activationId],
  );
  if (found[0] === undefined) return { kind: 'unknown' };
  const activation = activationOf(found[0]);
  const scheduled = 'dueAt' in cause;
  if (activation.mode !== (scheduled ? 'scheduled' : 'event')) {
    return { kind: 'not_firing', mode: activation.mode };
  }
  // In a statement of its own, after the lock: one that waited on an adoption
  // sees the new pin, but anything else it reads keeps the snapshot it began with.
  const standing = await readStandingApproval(tx, activation.id);
  let outcome: OccurrenceOutcome = 'activation_off';
  if (activation.enabled) {
    outcome = standing === null || standing.revoked ? 'no_standing_approval' : 'approved';
  }
  if (outcome === 'approved' && !scheduled && !(await hasRoom(tx, [eventQueue]))) {
    outcome = 'over_intake_bound';
  }
  if (outcome === 'approved') outcome = await withinRates(tx, activation.id);
  const approvalId = outcome === 'approved' ? (standing?.id ?? null) : null;
  const dueAt = scheduled ? cause.dueAt : null;
  const eventId = scheduled ? null : cause.eventId;
  const inserted = await tx.query<OccurrenceDbRow>(
    `insert into public.activation_occurrences
       (business_id, id, activation_id, version_id, due_at, event_id, outcome, approval_id,
        recorded_at)
     values ((select public.app_business_id()), $1, $2, $3, $4, $5, $6, $7, statement_timestamp())
     on conflict do nothing
     returning ${OCCURRENCE_COLUMNS}`,
    [randomUUID(), activation.id, activation.versionId, dueAt, eventId, outcome, approvalId],
  );
  if (inserted[0] !== undefined) return { kind: 'claimed', occurrence: occurrenceOf(inserted[0]) };
  const first = await tx.query<OccurrenceDbRow>(
    `select ${OCCURRENCE_COLUMNS} from public.activation_occurrences
      where business_id = $1 and activation_id = $2 and (due_at = $3 or event_id = $4)`,
    [tx.businessId, activation.id, dueAt, eventId],
  );
  if (first[0] === undefined)
    throw new Error('claimOccurrence: a conflicting occurrence is not visible');
  return { kind: 'replayed', occurrence: occurrenceOf(first[0]) };
}

/**
 * This business's approved occurrences with no dispatch yet, oldest first: the
 * events queued at intake and the runs waiting on the ceiling (C33), which the
 * worker dispatches again as runs finish.
 */
export async function waitingOccurrences(tx: TenantQuery, limit = 50): Promise<OccurrenceRow[]> {
  const rows = await tx.query<OccurrenceDbRow>(
    `select ${OCCURRENCE_COLUMNS} from public.activation_occurrences o
      where o.business_id = $1 and ${NOT_DISPATCHED}
      order by recorded_at, id
      limit $2`,
    [tx.businessId, Number.isSafeInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50],
  );
  return rows.map((row) => occurrenceOf(row));
}

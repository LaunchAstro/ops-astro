// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-5: a task's token ledger, from the reservation ledger (CS-6.5).
//
// Each envelope on the task is an allowance: its maximum, what is held and
// what was spent against it, and what it was built from, which is the cap it
// draws on and the approval whose reservation opened it. The per-run rows are
// the proposals' reservations (`proposals.ts`), each naming its envelope, so
// they add up to it. The envelopes are one more shape of the proposals' one
// statement (`readVerifiedProjection`), so an envelope's held and spent and
// the reservations beside it are the same snapshot. Read only, inside the task
// read, so a reader who may not read the task is told nothing of it; nothing
// is written or audited beyond the read's own event.
//
// AW-05's ceiling, its stops and the consolidated decision (the panel's stop
// states) are SL11's and join here when they land.

import type { EnvelopeView, TaskLedgerView } from '../../../core-wire/src/index.ts';

export interface EnvelopeRow {
  readonly id: string;
  readonly state: 'open' | 'closed';
  readonly maximum_minor: string;
  readonly held_minor: string;
  readonly actual_minor: string;
  readonly currency: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly opened_by: string | null;
  readonly cap_key: string;
  readonly cap_limit: string;
  readonly cap_currency: string;
}

/** One shape of the proposals' projection: `$1` the business, `$2` the task. */
export const ENVELOPES = `select row_number() over (order by (e.state = 'open') desc, e.opened_at desc, e.id)
              as ordinal,
            e.id, e.state, e.maximum_minor::text as maximum_minor,
            e.held_minor::text as held_minor, e.actual_minor::text as actual_minor,
            e.currency, e.opened_at, e.closed_at,
            (select r.version_id from public.reservations r
              where r.business_id = e.business_id and r.envelope_id = e.id
              order by r.created_at, r.id limit 1) as opened_by,
            cap.key as cap_key, cap.limit_minor::text as cap_limit, cap.currency as cap_currency
       from public.task_envelopes e
       join public.budget_caps cap on cap.business_id = e.business_id and cap.id = e.cap_id
      where e.business_id = $1 and e.task_id = $2::uuid`;

const isoTime = (text: string): string => new Date(text).toISOString();

const envelopeView = (row: EnvelopeRow): EnvelopeView => ({
  id: row.id,
  state: row.state,
  maximumMinor: Number(row.maximum_minor),
  heldMinor: Number(row.held_minor),
  actualMinor: Number(row.actual_minor),
  currency: row.currency,
  openedAt: isoTime(row.opened_at),
  closedAt: row.closed_at === null ? null : isoTime(row.closed_at),
  openedBy: row.opened_by === null ? null : { versionId: row.opened_by },
  cap: { key: row.cap_key, limitMinor: Number(row.cap_limit), currency: row.cap_currency },
});

/** The task's envelopes, in the projection's order: the open one first, then the closed ones, newest first. */
export const ledgerOf = (rows: readonly EnvelopeRow[]): TaskLedgerView => ({
  envelopes: rows.map((row) => envelopeView(row)),
});

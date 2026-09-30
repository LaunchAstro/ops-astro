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
// AW-05's stops ride beside them, one more shape of the same statement: each
// ask on a run of this task, its answer if one was given, and a first top-up
// still waiting for a second person above the band. The panel shows them and
// the pane's answers are C54's, sent to `run.top_up` and
// `run.end_at_budget_stop`, which decide under their own locks.

import type { BudgetStopView, EnvelopeView, TaskLedgerView } from '../../../core-wire/src/index.ts';

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

export interface StopRow {
  readonly id: string;
  readonly run_id: string;
  readonly ask_number: number;
  readonly kind: 'stop' | 'consolidated';
  readonly ceiling_minor: string;
  readonly spent_minor: string;
  readonly currency: string;
  readonly raised_at: string;
  readonly answer: 'top_up' | 'end' | null;
  readonly pending_minor: string | null;
}

/**
 * The stops on the task's runs, `$1` the business, `$2` the task. The run is
 * found on this task in this business, and each ask, answer and approval
 * through it, so nothing of another task's runs is read. A waiting top-up is
 * the one approval on an unanswered ask: two approvals of the same amount
 * complete it in the transaction that records the second.
 */
export const STOPS = `select row_number() over (order by run.created_at, run.id, a.ask_number) as ordinal,
            a.id, a.run_id, a.ask_number, a.kind,
            a.ceiling_minor::text as ceiling_minor, a.spent_minor::text as spent_minor,
            a.currency, a.raised_at,
            (select b.kind from public.budget_answers b
              where b.business_id = a.business_id and b.ask_id = a.id) as answer,
            (select p.amount_minor::text from public.budget_approvals p
              where p.business_id = a.business_id and p.ask_id = a.id
                and not exists (select 1 from public.budget_answers b
                                 where b.business_id = a.business_id and b.ask_id = a.id)
              order by p.approved_at desc, p.id limit 1) as pending_minor
       from public.budget_asks a
       join public.planned_runs run on run.business_id = a.business_id and run.id = a.run_id
      where a.business_id = $1 and run.task_id = $2::uuid`;

const stopView = (row: StopRow): BudgetStopView => ({
  askId: row.id,
  runId: row.run_id,
  number: Number(row.ask_number),
  kind: row.kind,
  ceilingMinor: Number(row.ceiling_minor),
  spentMinor: Number(row.spent_minor),
  currency: row.currency,
  raisedAt: isoTime(row.raised_at),
  answer: row.answer,
  awaitingSecond: row.pending_minor === null ? null : { amountMinor: Number(row.pending_minor) },
});

/**
 * The task's envelopes, in the projection's order (the open one first, then
 * the closed ones, newest first), and its stops, from the statement's rows.
 */
export const ledgerOf = (rows: Readonly<Record<string, readonly unknown[]>>): TaskLedgerView => ({
  envelopes: ((rows['envelopes'] ?? []) as readonly EnvelopeRow[]).map((row) => envelopeView(row)),
  stops: ((rows['stops'] ?? []) as readonly StopRow[]).map((row) => stopView(row)),
});

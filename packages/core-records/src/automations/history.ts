// SPDX-License-Identifier: AGPL-3.0-only
//
// One activation's history (#1741), as `automation.history` reads it: its
// occurrences (C33) and the applied changes people made to it, merged in one
// statement, newest first by time and then id, a page at a time after a
// keyset cursor. A change is an applied audit event of a command on the
// activation, or a revocation of one of its standing approvals (C52-A); the
// actor is joined inside this business, as a task's history joins it. Every
// statement names the transaction's business on top of row security. It
// writes nothing.

import type { TenantQuery } from '../tenancy/database.ts';

/** The commands whose audit event is the activation's own change, by its subject. */
const ACTIVATION_COMMANDS: readonly string[] = [
  'activation.change',
  'activation.adopt',
  'activation.roll_back',
  'activation.turn_off',
];

/** Where a page starts: the time, to the microsecond, and the id of the last entry before it. */
export interface ActivationHistoryCursor {
  readonly at: string;
  readonly id: string;
}

export interface ActivationHistoryRow {
  readonly kind: 'occurrence' | 'change';
  readonly id: string;
  readonly at: Date;
  /** The entry's time to the microsecond, as a cursor carries it. */
  readonly atKey: string;
  readonly dueAt: Date | null;
  readonly outcome: string | null;
  readonly dispatch: string | null;
  readonly runId: string | null;
  readonly command: string | null;
  readonly actorId: string | null;
  readonly actorKind: string | null;
  readonly actorName: string | null;
}

interface ActivationHistoryDbRow {
  readonly kind: 'occurrence' | 'change';
  readonly id: string;
  readonly at: Date;
  readonly at_key: string;
  readonly due_at: Date | null;
  readonly outcome: string | null;
  readonly dispatch: string | null;
  readonly run_id: string | null;
  readonly command: string | null;
  readonly actor_id: string | null;
  readonly actor_kind: string | null;
  readonly actor_name: string | null;
}

// An event's own id is never selected: an occurrence says only that an event
// caused it (`due_at` null). The cursor's time is bound as text and cast here:
// bound as a timestamp, the driver would pass it through a Date and drop its
// microseconds, and a page boundary inside a tie would skip the rest of it.
const HISTORY_SQL = `with entries as (
    select 'occurrence' as kind, o.id, o.recorded_at as at, o.due_at, o.outcome,
           d.outcome as dispatch, coalesce(d.run_id, o.run_id) as run_id,
           null::text as command, null::uuid as actor_id, null::text as actor_kind,
           null::text as actor_name
      from public.activation_occurrences o
      left join public.occurrence_dispatches d
        on d.business_id = o.business_id and d.occurrence_id = o.id
     where o.business_id = $1 and o.activation_id = $2
    union all
    select 'change', e.id, e.occurred_at, null, null, null, null, e.command, e.actor_id, a.kind,
           case when a.kind = 'person' then p.display_name end
      from public.audit_events e
      left join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
      left join public.people p on p.business_id = a.business_id and p.id = a.person_id
     where e.business_id = $1 and e.outcome = 'applied'
       and ((e.command = any($3::text[]) and e.subject_record_id = $2)
         or (e.command = 'approval.revoke' and e.subject_record_id in
               (select s.id from public.standing_approvals s
                 where s.business_id = $1 and s.activation_id = $2)))
  )
  select kind, id, at, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_key,
         due_at, outcome, dispatch, run_id, command, actor_id, actor_kind, actor_name
    from entries
   where $4::text is null or (at, id) < ($4::text::timestamptz, $5::uuid)
   order by at desc, id desc
   limit $6`;

const rowOf = (row: ActivationHistoryDbRow): ActivationHistoryRow => ({
  kind: row.kind,
  id: row.id,
  at: row.at,
  atKey: row.at_key,
  dueAt: row.due_at,
  outcome: row.outcome,
  dispatch: row.dispatch,
  runId: row.run_id,
  command: row.command,
  actorId: row.actor_id,
  actorKind: row.actor_kind,
  actorName: row.actor_name,
});

/** Whether the activation is one of this business's; another's answers as one that is not there. */
export async function activationExists(tx: TenantQuery, activationId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    'select id from public.activations where business_id = $1 and id = $2',
    [tx.businessId, activationId],
  );
  return rows.length > 0;
}

/** Up to `limit` entries of the activation's history older than `after`, newest first. */
export async function listActivationHistory(
  tx: TenantQuery,
  activationId: string,
  after: ActivationHistoryCursor | undefined,
  limit: number,
): Promise<readonly ActivationHistoryRow[]> {
  const rows = await tx.query<ActivationHistoryDbRow>(HISTORY_SQL, [
    tx.businessId,
    activationId,
    ACTIVATION_COMMANDS,
    after?.at ?? null,
    after?.id ?? null,
    limit,
  ]);
  return rows.map((row) => rowOf(row));
}

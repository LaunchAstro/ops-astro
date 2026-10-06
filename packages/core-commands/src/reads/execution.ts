// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.execution`: the task's view of its runs (specification 14.4 item 5).
// Every run naming the task is reported on its own, never merged or narrowed
// to a current one, with a page of `run_events` after the caller's cursor.
//
// `reads/dispatch.ts` asks the grant at the task's record scope first, so there
// is no denied branch here to answer with an empty list. Of the six read
// outcomes this body carries `ready`, `no-run` and `stale` (a cursor past the
// stream's end, where `ready` would claim the caller is up to date); `denied`
// and `unavailable` are refusals and faults, and `loading` is the client's.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { PLAN_CANDIDATES, boundPlans, spentNowOf } from '../../../core-runtime/src/index.ts';
import { projectGraph, type ExecutionGraph } from './execution-graph.ts';
import {
  PLACEMENT_FACTS,
  placeEvents,
  type EventPlacement,
  type PlacedPlan,
} from './execution-placement.ts';
import { DEFINITION_FACTS } from './execution-definition.ts';
import { HELPER_FACTS } from './execution-helpers.ts';

/** The most events one read returns. `next` is the handle for the rest. */
export const EXECUTION_PAGE = 200;

export interface ExecutionRun {
  readonly runId: string;
  readonly lineageId: string;
  readonly versionId: string;
  readonly state: string;
  /** Null for a run planned before 0032, where the revision was never recorded. */
  readonly taskRevisionAtRequest: number | null;
  readonly createdAt: string;
}

export interface ExecutionEvent {
  readonly eventId: string;
  readonly runId: string;
  /** The task-wide order, across its runs. The cursor is one of these. */
  readonly position: number;
  readonly kind: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly actorId: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
  /** The plan its run was proposed under, as recorded (MP-6-2, `execution-placement.ts`). */
  readonly placement: EventPlacement;
}

type StoredEvent = Omit<ExecutionEvent, 'placement'>;

export interface TaskExecution {
  readonly outcome: 'ready' | 'no-run' | 'stale';
  readonly taskId: string;
  /** The highest position recorded on the task when this read ran; 0 for none. */
  readonly sourceRevision: number;
  /** Whether `events` reaches `sourceRevision`. */
  readonly complete: boolean;
  /** The cursor that retrieves what this page omitted, or null when nothing was. */
  readonly next: number | null;
  readonly runs: readonly ExecutionRun[];
  readonly events: readonly ExecutionEvent[];
  /** Planned and observed, per run (AW-06, `execution-graph.ts`). */
  readonly graph: ExecutionGraph;
  /** The steps of every bound plan record a run of the task was proposed under. */
  readonly plans: readonly PlacedPlan[];
}

export async function readTaskExecution(
  tx: TenantQuery,
  taskId: string,
  cursor: number,
): Promise<TaskExecution> {
  const { runs, sourceRevision, events, facts, plans, placements } = await snapshot(
    tx,
    taskId,
    cursor,
  );
  const last = events.at(-1)?.position ?? cursor;
  const complete = last >= sourceRevision;
  const bound = boundPlans(plans);
  const placed = placeEvents(placements, bound, events);
  return {
    outcome: runs.length === 0 ? 'no-run' : cursor > sourceRevision ? 'stale' : 'ready',
    taskId,
    sourceRevision,
    complete,
    next: complete ? null : last,
    runs,
    events: placed.events,
    graph: projectGraph(facts, bound[0] ?? null, sourceRevision, complete),
    plans: placed.plans,
  };
}

/** A timestamp in the shape `Date.toISOString` gives, formatted by the server. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Each run's facts for the graph (AW-06, `execution-graph.ts`): its gate, its
 * version, its latest lease and attempt, its reservations, its last event at
 * or before the head, its helpers (AW-11) and its pin and read ledger (AW-04). `$1` is the business, `$2`
 * the task; `head` is the statement's own event head.
 */
const RUN_FACTS = `coalesce((select json_agg(json_build_object(
    'runId', run.id, 'lineageId', run.lineage_id, 'state', run.state,
    'superseded', ver.superseded_at is not null,
    'planStepKey', (select st.plan_step_key from public.planned_steps st
      where st.business_id = $1 and st.run_id = run.id and st.ordinal = 1),
    'currency', ver.currency,
    -- A pending gate past its deadline reads expired, derived as task.read
    -- derives it (reads/proposals.ts): the stored row stays pending.
    'gateState', case when gate.state = 'pending' and gate.expires_at <= now()
                      then 'expired' else gate.state end,
    'lease', (select json_build_object(
        'state', l.state,
        'expiresAt', to_char(l.expires_at at time zone 'UTC', ${ISO}),
        'lapsed', l.state = 'live' and l.expires_at <= now(),
        'holderActorId', l.holder_actor_id,
        'agent', l.delegation_id is not null)
      from public.leases l where l.business_id = $1 and l.run_id = run.id
      order by l.acquired_at desc, l.id desc limit 1),
    'attempt', (select json_build_object('id', a.id, 'state', a.state, 'outcome', a.outcome)
      from public.attempts a where a.business_id = $1 and a.run_id = run.id
      order by a.created_at desc, a.id desc limit 1),
    'effectObserved', coalesce((select bool_or(a.observed or a.state = 'settled')
      from public.attempts a where a.business_id = $1 and a.run_id = run.id), false),
    'heldMinor', (select sum(res.held_minor)::float8 from public.reservations res
      where res.business_id = $1 and res.run_id = run.id
        and res.state in ('held', 'quarantined')),
    -- A classifier's settle counts its calls as they stand now (spentNowOf).
    'spentMinor', (select nullif(sum(case when att.state = 'settled' then res.actual_minor
                                          else ${spentNowOf('res')} end), 0)::float8
      from public.reservations res
      join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
      where res.business_id = $1 and res.run_id = run.id and res.state = 'actual'),
    'lastKind', last.kind, 'lastFault', last.detail ->> 'fault',
    -- The helpers the run's work was handed to (AW-11, execution-helpers.ts).
    'helpers', ${HELPER_FACTS},
    -- Its pinned instruction file and read ledger (AW-04, execution-definition.ts).
    'definition', ${DEFINITION_FACTS})
  order by run.created_at, run.id)
  from public.planned_runs run
  join public.proposal_versions ver
    on ver.business_id = run.business_id and ver.id = run.version_id
  left join public.gates gate
    on gate.business_id = run.business_id and gate.version_id = run.version_id
  left join lateral (select ev.kind, ev.detail from public.run_events ev
      where ev.business_id = $1 and ev.run_id = run.id
        and ev.position <= (select n from head)
        -- The run's own progress: a helper's hand-over and handback (AW-11)
        -- never stand in for the run's last move or hide its drop.
        and ev.kind not in ('delegated', 'child_handed_back')
      order by ev.position desc limit 1) last on true
 where run.business_id = $1 and run.task_id = $2), '[]')`;

interface Snapshot {
  readonly runs: readonly ExecutionRun[];
  readonly sourceRevision: number;
  readonly events: readonly StoredEvent[];
  readonly facts: unknown;
  readonly plans: unknown;
  readonly placements: unknown;
}

/**
 * The runs, the event head, one page of events, each run's facts for the
 * graph, the task's plan records (`PLAN_CANDIDATES`, bound or not, checked
 * by `boundPlans`) and each run's placement (`PLACEMENT_FACTS`), read by one
 * statement so all six come from one snapshot: separate reads could see a
 * successor's events without its run, or a hand-back's
 * event without its settled attempt. The facts read the whole run, never the
 * page, so a condition does not depend on the cursor; `lastKind` stops at the
 * head, as the page does. Counters come back as
 * `float8`, exact to 2^53 as a JS number is, so the rows need no mapping.
 */
async function snapshot(tx: TenantQuery, taskId: string, cursor: number): Promise<Snapshot> {
  const rows = await tx.query<Snapshot>(
    `with head as (
       select coalesce(max(position), 0) as n
         from public.run_events where business_id = $1 and task_id = $2
     ), page as (
       select * from public.run_events
        where business_id = $1 and task_id = $2
          and position > $3 and position <= (select n from head)
        order by position limit $4
     )
     select (select n from head)::float8 as "sourceRevision",
            coalesce((select json_agg(json_build_object(
                'runId', id, 'lineageId', lineage_id, 'versionId', version_id, 'state', state,
                'taskRevisionAtRequest', task_revision_at_request::float8,
                'createdAt', to_char(created_at at time zone 'UTC', ${ISO}))
              order by created_at, id)
              from public.planned_runs where business_id = $1 and task_id = $2), '[]') as runs,
            coalesce((select json_agg(json_build_object(
                'eventId', id, 'runId', run_id, 'position', position::float8, 'kind', kind,
                'leaseId', lease_id, 'attemptId', attempt_id, 'actorId', actor_id,
                'detail', detail, 'at', to_char(created_at at time zone 'UTC', ${ISO}))
              order by position)
              from page), '[]') as events,
            ${RUN_FACTS} as facts,
            ${PLAN_CANDIDATES} as plans,
            ${PLACEMENT_FACTS} as placements`,
    [tx.businessId, taskId, cursor, EXECUTION_PAGE],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('task.execution: the snapshot returned no row');
  return row;
}

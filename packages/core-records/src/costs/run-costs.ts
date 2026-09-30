// SPDX-License-Identifier: AGPL-3.0-only
//
// What agent runs cost (U39: MP-14-9, MP-14-6), in money minor units, from
// the broker's own model calls (AW-01). One row per run, agent and currency:
// the spend of the run's settled calls, and how many of its started calls
// have no settled cost yet (in flight, or their liability unknown), so a run
// with any such call is unpriced rather than cheaper than it was. A call's
// currency is its reservation's envelope's. A run's client is its task's
// party link; its skill is the definition its `definition_version` pin names,
// when that definition is a skill.
//
// `listRunCosts` filters by the scopes the caller holds `finance:read` at,
// inside the statement, in the serving transaction: a business-wide holder
// sees every run, a client-scoped holder only the runs whose task names that
// client (never the agency's own runs), and row security keeps every table to
// the caller's business.

import type { Scope } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

export interface RunCostRow {
  readonly runId: string;
  readonly taskId: string;
  readonly agentActorId: string | null;
  readonly currency: string;
  /** The settled calls' spend, as text: a bigint sum. */
  readonly settledMinor: string;
  /** Started calls with no settled cost: in flight or liability unknown. */
  readonly openCalls: number;
  readonly startedAt: Date;
  readonly finished: boolean;
  readonly clientId: string | null;
  readonly clientName: string | null;
  readonly skillId: string | null;
  readonly skillName: string | null;
}

interface Row {
  readonly run_id: string;
  readonly task_id: string;
  readonly agent_actor_id: string | null;
  readonly currency: string;
  readonly settled_minor: string;
  readonly open_calls: number;
  readonly started_at: Date;
  readonly finished: boolean;
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly skill_id: string | null;
  readonly skill_name: string | null;
}

/** One row per run, agent and currency: `$1` business-wide, `$2` parties, `$3`-`$4` the window. */
const RUN_COSTS = `with spent as (
     select c.business_id, c.run_id, d.agent_actor_id, e.currency,
            coalesce(sum(c.actual_minor), 0)::text as settled_minor,
            (count(*) filter (where c.state <> 'settled'))::int as open_calls,
            min(c.started_at) as started_at
       from public.model_calls c
       join public.reservations r
         on r.business_id = c.business_id and r.id = c.reservation_id
       join public.task_envelopes e
         on e.business_id = r.business_id and e.id = r.envelope_id
       left join public.delegations d
         on d.business_id = c.business_id and d.id = c.delegation_id
      where c.run_id is not null and c.started_at is not null
      group by c.business_id, c.run_id, d.agent_actor_id, e.currency
   )
   select s.run_id, p.task_id, s.agent_actor_id, s.currency, s.settled_minor, s.open_calls,
          s.started_at,
          exists (select 1 from public.handback_reports h
                   where h.business_id = p.business_id and h.run_id = p.id
                     and h.outcome = 'completed') as finished,
          t.uuid_7 as client_id,
          (select cr.txt_1 from public.records cr
             join public.record_types ct
               on ct.business_id = cr.business_id and ct.id = cr.record_type_id
            where cr.business_id = t.business_id and cr.id = t.uuid_7
              and ct.key = 'client') as client_name,
          sd.id as skill_id, sd.name as skill_name
     from spent s
     join public.planned_runs p on p.business_id = s.business_id and p.id = s.run_id
     join public.records t on t.business_id = p.business_id and t.id = p.task_id
     left join public.run_definition_pins pin
       on pin.business_id = p.business_id and pin.run_id = p.id
      and pin.ref_kind = 'definition_version'
     left join public.definition_versions v
       on v.business_id = pin.business_id and v.id = pin.definition_version_id
     left join public.automation_definitions sd
       on sd.business_id = v.business_id and sd.id = v.definition_id and sd.kind = 'skill'
    where ($1::boolean or t.uuid_7 = any($2::uuid[]))
      and ($3::timestamptz is null or s.started_at >= $3)
      and ($4::timestamptz is null or s.started_at < $4)
    order by s.started_at, s.run_id, s.agent_actor_id nulls last, s.currency`;

const rowOf = (row: Row): RunCostRow => ({
  runId: row.run_id,
  taskId: row.task_id,
  agentActorId: row.agent_actor_id,
  currency: row.currency,
  settledMinor: row.settled_minor,
  openCalls: row.open_calls,
  startedAt: row.started_at,
  finished: row.finished,
  clientId: row.client_id,
  clientName: row.client_name,
  skillId: row.skill_id,
  skillName: row.skill_name,
});

/** A half-open window on a run's first started call; either end may be open. */
export interface CostPeriod {
  readonly from: Date | null;
  readonly to: Date | null;
}

const ALL_TIME: CostPeriod = { from: null, to: null };

/** The runs these scopes may read, one row per run, agent and currency, oldest first. */
export async function listRunCosts(
  tx: TenantQuery,
  scopes: readonly Scope[],
  period: CostPeriod = ALL_TIME,
): Promise<readonly RunCostRow[]> {
  const whole = scopes.some((scope) => scope.kind === 'business');
  const parties = scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id);
  const rows = await tx.query<Row>(RUN_COSTS, [whole, parties, period.from, period.to]);
  return rows.map((row) => rowOf(row));
}

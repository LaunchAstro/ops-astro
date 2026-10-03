// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2: where each of `task.execution`'s events sits in the plans, as its
// run was placed when it was proposed, for the operational log.
//
// The graph (AW-06, `execution-graph.ts`) places every run against the plan
// projected now, the newest bound record, so a re-plan moves the runs under
// the older plan. The log's rows are evidence and must not move, so each
// event carries its run's own placement instead:
//
//   the plan's run  the run a bound record was accepted on, or a run of that
//                   run's lineage proposed once it was bound: the plan itself;
//   a work run      the record stored with its step (20261003001115): the bound
//                   record `task.propose` checked the step key against under
//                   the task lock, with the step key the proposal named;
//   neither         no plan record: the run was proposed under no plan.
//
// A record bound later is newer than every run already proposed, so it adds
// placements and changes none. The read carries the steps of every record a
// run of the task is placed under, so a row resolves against its own plan.
//
// "Bound before" a run is the stored record and every record ordered below it
// (`bound_at`, then id, the projection's own order), on the run's own task
// only. A step written before 20261003001115 stored none (`plan_record_written` false)
// and keeps the placement by time: bound at or before the run's `created_at`.
// Both clocks are their transaction's start, so for those rows alone an
// accept that began before a proposal and took the task lock after it still
// reads as bound first.

import type { ProjectedPlan } from '../../../core-runtime/src/index.ts';

/**
 * Each of the task's runs: its lineage, the plan step key its proposal named,
 * and the ids of the task's plan records bound before it was proposed, newest
 * first. `$1` the business, `$2` the task.
 */
export const PLACEMENT_FACTS = `coalesce((select json_agg(json_build_object(
    'runId', run.id, 'lineageId', run.lineage_id, 'planStepKey', st.plan_step_key,
    'boundBefore', coalesce((select json_agg(pr.id order by pr.bound_at desc, pr.id desc)
      from public.plan_records pr
      join public.planned_runs prun on prun.business_id = pr.business_id and prun.id = pr.run_id
      where pr.business_id = $1 and prun.task_id = $2
        and case when st.plan_record_written
          then (pr.bound_at, pr.id) <= (stored.bound_at, stored.id)
          else pr.bound_at <= run.created_at end), '[]'))
  order by run.created_at, run.id)
  from public.planned_runs run
  left join public.planned_steps st
    on st.business_id = run.business_id and st.run_id = run.id and st.ordinal = 1
  left join lateral (select own.bound_at, own.id from public.plan_records own
      join public.planned_runs own_run
        on own_run.business_id = own.business_id and own_run.id = own.run_id
     where own.business_id = $1 and own.id = st.plan_record_id and own_run.task_id = $2) stored
    on true
 where run.business_id = $1 and run.task_id = $2), '[]')`;

/** The plan an event's run was proposed under, as recorded. */
export interface EventPlacement {
  /** The bound record, or null when the run was proposed under none. */
  readonly planRecordId: string | null;
  /** The plan step key the run's proposal named, or null. */
  readonly stepKey: string | null;
  /** The plan's own run, or a run of its lineage. */
  readonly planRun: boolean;
}

/** A bound plan record a run is placed under, with its steps. */
export interface PlacedPlan {
  readonly planRecordId: string;
  readonly steps: readonly { readonly key: string; readonly title: string }[];
}

interface PlacementFact {
  readonly runId: string;
  readonly lineageId: string;
  readonly planStepKey: string | null;
  readonly boundBefore: readonly string[];
}

const NOWHERE: EventPlacement = { planRecordId: null, stepKey: null, planRun: false };

/** Each event with its run's placement, and the plans those placements name. */
export function placeEvents<E extends { readonly runId: string }>(
  facts: unknown,
  plans: readonly ProjectedPlan[],
  events: readonly E[],
): {
  readonly events: readonly (E & { readonly placement: EventPlacement })[];
  readonly plans: readonly PlacedPlan[];
} {
  const runs = validatePlacementFacts(facts);
  const lineageOf = new Map(runs.map((run) => [run.runId, run.lineageId]));
  const byId = new Map(plans.map((plan) => [plan.planRecordId, plan]));
  const placementOf = (run: PlacementFact): EventPlacement => {
    // A record accepted later on this run's lineage is not the plan it ran in.
    const own = plans.findLast(
      (plan) =>
        plan.runId === run.runId ||
        (run.boundBefore.includes(plan.planRecordId) &&
          lineageOf.get(plan.runId) === run.lineageId),
    );
    if (own !== undefined) return { planRecordId: own.planRecordId, stepKey: null, planRun: true };
    const under = run.boundBefore.find((id) => byId.has(id));
    return { planRecordId: under ?? null, stepKey: run.planStepKey, planRun: false };
  };
  const placements = new Map(runs.map((run) => [run.runId, placementOf(run)]));
  const named = new Set([...placements.values()].map((placement) => placement.planRecordId));
  return {
    events: events.map((event) => ({
      ...event,
      placement: placements.get(event.runId) ?? NOWHERE,
    })),
    plans: plans
      .filter((plan) => named.has(plan.planRecordId))
      .map((plan) => ({
        planRecordId: plan.planRecordId,
        steps: plan.steps.map((step) => ({ key: step.key, title: step.title })),
      })),
  };
}

function validatePlacementFacts(facts: unknown): readonly PlacementFact[] {
  if (!Array.isArray(facts)) throw new Error('task.execution: the placements are not a list');
  return facts.map((fact: unknown, index) => {
    const where = `task.execution: placement ${String(index)}`;
    if (typeof fact !== 'object' || fact === null) throw new Error(`${where} is not an object`);
    const { runId, lineageId, planStepKey, boundBefore } = fact as Record<string, unknown>;
    if (typeof runId !== 'string' || typeof lineageId !== 'string')
      throw new Error(`${where}: the run or its lineage is not a string`);
    if (planStepKey !== null && typeof planStepKey !== 'string')
      throw new Error(`${where}: planStepKey is neither null nor a string`);
    if (!Array.isArray(boundBefore) || !boundBefore.every((id) => typeof id === 'string'))
      throw new Error(`${where}: boundBefore is not a list of ids`);
    return { runId, lineageId, planStepKey, boundBefore: boundBefore as readonly string[] };
  });
}

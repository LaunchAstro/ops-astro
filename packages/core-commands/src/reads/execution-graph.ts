// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06: the execution graph `task.execution` carries beside its runs and
// events. One node per run, each with a planned layer and an observed layer,
// never merged into one reading.
//
// **The planned layer is the bound plan record** (AW-04, owner decision U4):
// the one `projectedPlan` (`core-runtime/src/plan-binding.ts`) finds bound to
// its approving decision, or none, and then the graph says `plan: 'unbound'`
// with no steps, so no reader mistakes an absent plan for an empty one and no
// node is called unplanned against a plan nobody bound. With a plan, the
// graph lists its steps with the runs proposed under each, and each run
// carries the step its proposal named (ORCH41 decision (a)). A run naming
// none, or a key the bound plan lacks, reads `unplanned`, never dropped. The
// plan's own run, and the runs of its lineage, are the plan, not work
// outside it. A helper's steps (AW-11) take their run's placement, the step
// or unplanned, as the node reads.
//
// **The observed layer comes from the run's own rows**: the run, its gate,
// its version, its latest lease and attempt, and its reservations, read in the
// same snapshot as the events (`execution.ts`). A page of events never changes
// a condition, and silence never does either: a run with no progress after its
// claim stays in progress until something recorded moves it (a hand-back, a
// cancel, a drop). Past its lease's expiry and before any drop, its lease says
// `lapsed`; the drop, when the recovery path writes it, shows with its fault.
//
// Absent money is null, never 0. An effect counts as observed only when its
// attempt was observed or settled: a dispatch marker (a staged intent) is not.
//
// **This module computes no authority.** It takes facts the grant-checked read
// already fetched and returns the same projection to every reader who may see
// the task; it imports nothing from the grant model.
//
// Validation runs first: a fact of the wrong shape throws, so the read answers
// as unavailable rather than drawing a graph from a row it could not read. A
// run state this module does not know is kept raw (`runState`) with the
// condition `unrecognised`, never dropped.

import { helpersOf, type HelperEntry, type PlacedStep } from './execution-helpers.ts';

/** What `execution.ts` reads for each run. */
export interface RunFacts {
  readonly runId: string;
  readonly lineageId: string;
  readonly state: string;
  /** The plan step its proposal named (0061), or null. */
  readonly planStepKey: string | null;
  readonly superseded: boolean;
  readonly gateState: string | null;
  readonly currency: string;
  readonly lease: {
    readonly state: string;
    readonly expiresAt: string;
    readonly lapsed: boolean;
    readonly holderActorId: string;
    readonly agent: boolean;
  } | null;
  readonly attempt: {
    readonly id: string;
    readonly state: string;
    readonly outcome: string | null;
  } | null;
  readonly effectObserved: boolean;
  readonly heldMinor: number | null;
  readonly spentMinor: number | null;
  readonly lastKind: string | null;
  readonly lastFault: string | null;
  /** AW-11's helpers, as `execution-helpers.ts` reads them. */
  readonly helpers: readonly HelperEntry[];
}

export type ObservedCondition =
  'not_started' | 'in_progress' | 'settled' | 'superseded' | 'unrecognised';

/** A node's reading: its observed condition, or `unplanned` under a bound plan. */
export type NodeCondition = ObservedCondition | 'unplanned';

export interface WhoseMove {
  readonly kind: 'agent' | 'person';
  /** The lease's holder; null when the move is anyone's with the grant (a pickup, a budget answer). */
  readonly actorId: string | null;
}

export interface ObservedLayer {
  readonly condition: ObservedCondition;
  /** The run's stored state, carried forward as a display state. */
  readonly runState: string;
  readonly attemptId: string | null;
  /** In progress only. */
  readonly whoseMove: WhoseMove | null;
  /** Settled only: the attempt's outcome, `cancelled`, `refused` or `expired`. */
  readonly outcome: string | null;
  /** The fault a drop recorded, while that drop is the run's last event. */
  readonly fault: string | null;
  readonly lease: { readonly state: string; readonly expiresAt: string } | null;
  readonly effectObserved: boolean;
  readonly heldMinor: number | null;
  readonly spentMinor: number | null;
  readonly currency: string;
}

export interface GraphNode {
  readonly nodeId: string;
  /** The observed condition, or `unplanned`: a run outside the bound plan. */
  readonly condition: NodeCondition;
  /** The bound plan's step this run was proposed under, or null. */
  readonly planned: { readonly key: string; readonly title: string } | null;
  readonly observed: ObservedLayer;
  /** The helpers the run's work was handed to, each with its own steps (AW-11). */
  readonly helpers: readonly HelperEntry<PlacedStep>[];
}

/** A step of the bound plan, with the runs proposed under it (none yet: planned). */
export interface PlannedStepNode {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly runIds: readonly string[];
}

export interface ExecutionGraph {
  readonly plan: 'bound' | 'unbound';
  readonly planRecordId: string | null;
  /** The run the plan was accepted on. */
  readonly planRunId: string | null;
  readonly steps: readonly PlannedStepNode[];
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly GraphNode[];
}

/** The bound plan the graph projects (`projectedPlan`), or null. */
export interface GraphPlan {
  readonly planRecordId: string;
  readonly runId: string;
  readonly steps: readonly {
    readonly key: string;
    readonly title: string;
    readonly after: readonly string[];
  }[];
}

export function projectGraph(
  facts: unknown,
  plan: GraphPlan | null,
  sourceRevision: number,
  complete: boolean,
): ExecutionGraph {
  const runs = validateFacts(facts);
  const planLineage = runs.find((run) => run.runId === plan?.runId)?.lineageId;
  const stepOf = (run: RunFacts) => plan?.steps.find((step) => step.key === run.planStepKey);
  return deepFreeze({
    plan: plan === null ? 'unbound' : 'bound',
    planRecordId: plan?.planRecordId ?? null,
    planRunId: plan?.runId ?? null,
    steps: (plan?.steps ?? []).map((step) => ({
      key: step.key,
      title: step.title,
      after: [...step.after],
      runIds: runs.filter((run) => stepOf(run) === step).map((run) => run.runId),
    })),
    sourceRevision,
    complete,
    nodes: runs.map((run) => {
      const observed = observe(run);
      const step = stepOf(run);
      const outside = plan !== null && step === undefined && run.lineageId !== planLineage;
      const planned = step === undefined ? null : { key: step.key, title: step.title };
      return {
        nodeId: run.runId,
        condition: outside ? 'unplanned' : observed.condition,
        planned,
        observed,
        // A helper's steps are model calls, which carry no plan key: each takes
        // this run's placement (ORCH42 decision (a)).
        helpers: run.helpers.map((helper) => ({
          ...helper,
          steps: helper.steps.map((one) => ({ ...one, planned, unplanned: outside })),
        })),
      };
    }),
  });
}

const SETTLED_BY_GATE: Readonly<Record<string, string>> = {
  rejected: 'refused',
  expired: 'expired',
};

function observe(run: RunFacts): ObservedLayer {
  const base = {
    runState: run.state,
    attemptId: run.attempt?.id ?? null,
    fault: run.lastKind === 'dropped' ? run.lastFault : null,
    lease:
      run.lease === null
        ? null
        : { state: run.lease.lapsed ? 'lapsed' : run.lease.state, expiresAt: run.lease.expiresAt },
    effectObserved: run.effectObserved,
    heldMinor: run.heldMinor,
    spentMinor: run.spentMinor,
    currency: run.currency,
  };
  const settled = (outcome: string): ObservedLayer => ({
    ...base,
    condition: 'settled',
    whoseMove: null,
    outcome,
  });
  const other = (condition: ObservedCondition, whoseMove: WhoseMove | null): ObservedLayer => ({
    ...base,
    condition,
    whoseMove,
    outcome: null,
  });
  if (run.state === 'handed_back') return settled(run.attempt?.outcome ?? 'unknown');
  if (run.state === 'cancelled') return settled('cancelled');
  const byGate = run.gateState === null ? undefined : SETTLED_BY_GATE[run.gateState];
  if (byGate !== undefined) return settled(byGate);
  if (run.superseded) return other('superseded', null);
  if (run.state === 'claimed') {
    const lease = run.lease;
    return other(
      'in_progress',
      lease === null
        ? null
        : { kind: lease.agent ? 'agent' : 'person', actorId: lease.holderActorId },
    );
  }
  if (run.state === 'waiting_budget')
    return other('in_progress', { kind: 'person', actorId: null });
  // Back to planned after a drop: work began, and the next pickup is the move.
  if (run.state === 'planned')
    return run.attempt === null
      ? other('not_started', null)
      : other('in_progress', { kind: 'agent', actorId: null });
  return other('unrecognised', null);
}

function validateFacts(facts: unknown): readonly RunFacts[] {
  if (!Array.isArray(facts)) throw new Error('task.execution: the run facts are not a list');
  return facts.map((fact: unknown, index) => {
    const where = `task.execution: run fact ${String(index)}`;
    if (!isRecord(fact)) throw new Error(`${where} is not an object`);
    for (const key of ['runId', 'lineageId', 'state', 'currency'] as const) {
      if (typeof fact[key] !== 'string') throw new Error(`${where}: ${key} is not a string`);
    }
    for (const key of ['superseded', 'effectObserved'] as const) {
      if (typeof fact[key] !== 'boolean') throw new Error(`${where}: ${key} is not a boolean`);
    }
    for (const key of ['gateState', 'lastKind', 'lastFault', 'planStepKey'] as const) {
      if (fact[key] !== null && typeof fact[key] !== 'string')
        throw new Error(`${where}: ${key} is neither null nor a string`);
    }
    for (const key of ['heldMinor', 'spentMinor'] as const) {
      const value = fact[key];
      if (
        value !== null &&
        !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      )
        throw new Error(`${where}: ${key} is neither null nor a whole non-negative number`);
    }
    const { lease, attempt } = fact;
    if (
      lease !== null &&
      !(
        isRecord(lease) &&
        typeof lease['state'] === 'string' &&
        typeof lease['expiresAt'] === 'string' &&
        typeof lease['lapsed'] === 'boolean' &&
        typeof lease['holderActorId'] === 'string' &&
        typeof lease['agent'] === 'boolean'
      )
    )
      throw new Error(`${where}: the lease is malformed`);
    if (
      attempt !== null &&
      !(
        isRecord(attempt) &&
        typeof attempt['id'] === 'string' &&
        typeof attempt['state'] === 'string' &&
        (attempt['outcome'] === null || typeof attempt['outcome'] === 'string')
      )
    )
      throw new Error(`${where}: the attempt is malformed`);
    return { ...(fact as unknown as RunFacts), helpers: helpersOf(fact['helpers'], where) };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

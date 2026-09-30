// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06: the execution graph `task.execution` carries beside its runs and
// events. One node per run, each with a planned layer and an observed layer,
// never merged into one reading.
//
// **The planned layer is not read yet.** Planned nodes come from the
// structured plan record the plan decision bound (AW-04, owner decision U4),
// which this code does not have. Every node's planned layer is null and the
// graph says `plan: 'unbound'`, so no reader mistakes an absent plan for an
// empty one, and no node is called unplanned against a plan nobody read.
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

/** What `execution.ts` reads for each run. */
export interface RunFacts {
  readonly runId: string;
  readonly state: string;
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
}

export type ObservedCondition =
  'not_started' | 'in_progress' | 'settled' | 'superseded' | 'unrecognised';

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
  /** The node's reading: the observed condition while no plan is bound. */
  readonly condition: ObservedCondition;
  /** AW-04's bound plan record; null until it is read. */
  readonly planned: null;
  readonly observed: ObservedLayer;
}

export interface ExecutionGraph {
  readonly plan: 'unbound';
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly GraphNode[];
}

export function projectGraph(
  facts: unknown,
  sourceRevision: number,
  complete: boolean,
): ExecutionGraph {
  const runs = validateFacts(facts);
  return deepFreeze({
    plan: 'unbound',
    sourceRevision,
    complete,
    nodes: runs.map((run) => {
      const observed = observe(run);
      return { nodeId: run.runId, condition: observed.condition, planned: null, observed };
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
    for (const key of ['runId', 'state', 'currency'] as const) {
      if (typeof fact[key] !== 'string') throw new Error(`${where}: ${key} is not a string`);
    }
    for (const key of ['superseded', 'effectObserved'] as const) {
      if (typeof fact[key] !== 'boolean') throw new Error(`${where}: ${key} is not a boolean`);
    }
    for (const key of ['gateState', 'lastKind', 'lastFault'] as const) {
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
    return fact as unknown as RunFacts;
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

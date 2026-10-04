// SPDX-License-Identifier: AGPL-3.0-only
//
// A run's pinned definition, read ledger, checks and lease scope (AW-02,
// MP-6-1, MP-6-4), and the task's execution and receipt reads (T2a). Split from
// `views.ts`, which re-exports every one, to keep that file under the
// 1,000-line cap for product source.

/**
 * The run's pinned definition reference, as stored: a bootstrap file by path,
 * read at pin time, or a definition version by id. The digest and size are
 * the identity; the path is provenance only.
 */
export interface RunPinView {
  readonly kind: string;
  readonly path: string | null;
  readonly digest: string;
  readonly size: number;
  readonly readAt: string | null;
  readonly definitionVersionId: string | null;
  readonly pinnedAt: string;
}

/** One pinned read the run made, as its ledger row records it. */
export interface RunReadView {
  readonly sequence: number;
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly readAt: string;
  readonly isEntry: boolean;
}

/** One check a run recorded under its worker lease, against the version it ran on. */
export interface CheckView {
  readonly id: string;
  readonly name: string;
  readonly outcome: string;
  readonly note: string | null;
  /** The lease holder that performed it: the provenance is the lease, not a claim. */
  readonly performedByActorId: string;
  readonly recordedAt: string;
}

/** One grant a delegation draws on, for the link to it in the access ledger (R71). */
export interface CoveringGrantView {
  readonly id: string;
  readonly collection: string;
  readonly action: string;
  /** `business`, or `record` for a grant on this task alone. */
  readonly scopeKind: string;
}

/**
 * What a run was allowed to touch (MP-6-4, CS-6.1), set by the broker when the
 * lease was taken and read-only here: the lease's own delegation, never the
 * task's fields. A lease a person holds carries no delegation.
 */
export interface RunScopeView {
  readonly leaseId: string;
  /** When the lease was taken: the moment the run's context was pinned. */
  readonly acquiredAt: string;
  readonly delegation: {
    readonly id: string;
    readonly purpose: string;
    /** The one resource the delegation was minted for (the one-task ceiling). */
    readonly scope: { readonly kind: string; readonly id: string };
    readonly collections: readonly string[];
    readonly actions: readonly string[];
    readonly grantedAt: string;
    readonly expiresAt: string;
    /** `live`, or why it no longer is: `expired`, `revoked` or `settled`. */
    readonly state: string;
    /** The person whose live grants are its ceiling. */
    readonly delegatePersonId: string;
    /** That person's live grants it draws on now; empty when they hold none. */
    readonly grants: readonly CoveringGrantView[];
  } | null;
}

/** One run naming the task, as `task.execution` reports it (T2a); never merged. */
export interface ExecutionRun {
  readonly runId: string;
  readonly lineageId: string;
  readonly versionId: string;
  readonly state: string;
  readonly taskRevisionAtRequest: number | null;
  readonly createdAt: string;
}

/** One durable progress event, in the task-wide order. */
export interface ExecutionEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly position: number;
  readonly kind: string;
  /** The attempt the event is about; its receipt is read by this. */
  readonly attemptId: string;
  readonly at: string;
  /** The plan its run was proposed under, as recorded (MP-6-2); absent from an older read. */
  readonly placement?: {
    /** The bound plan record, or null when the run was proposed under none. */
    readonly planRecordId: string | null;
    readonly stepKey: string | null;
    /** The plan's own run, or a run of its lineage. */
    readonly planRun: boolean;
  };
}

/** `task.execution`'s answer, under `execution`; `denied`, `unavailable` and `loading` are the read's own. */
export interface TaskExecutionResult {
  readonly execution: TaskExecution;
}

export interface TaskExecution {
  readonly outcome: 'ready' | 'no-run' | 'stale';
  readonly runs: readonly ExecutionRun[];
  readonly events: readonly ExecutionEvent[];
  /** Whether `events` reaches the task's last recorded event. */
  readonly complete: boolean;
  /** The cursor for the rest, or null when nothing was left out. */
  readonly next: number | null;
  /** Planned and observed per run (AW-06); every reader who may see the task gets the same one. */
  readonly graph: ExecutionGraph;
  /** The steps of each bound plan record a run of the task was proposed under (MP-6-2). */
  readonly plans?: readonly {
    readonly planRecordId: string;
    readonly steps: readonly { readonly key: string; readonly title: string }[];
  }[];
}

/**
 * Planned and observed per run (AW-06). With AW-04's plan record bound to its
 * approval, `plan` is `bound` and `steps` lists the plan's steps with the runs
 * proposed under each; unbound, `steps` is empty and no node is planned.
 */
export interface ExecutionGraph {
  readonly plan: 'bound' | 'unbound';
  /** Absent on a read made before AW-04's plan was projected. */
  readonly steps?: readonly ExecutionStep[];
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly ExecutionNode[];
}

/** A step of the bound plan, with the runs proposed under it. */
export interface ExecutionStep {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly runIds: readonly string[];
}

export interface ExecutionNode {
  readonly nodeId: string;
  readonly condition: 'not_started' | 'in_progress' | 'settled' | 'superseded' | 'unrecognised';
  /** The bound plan's step this run was proposed under, or null. */
  readonly planned: { readonly key: string; readonly title: string } | null;
  readonly observed: {
    readonly condition: ExecutionNode['condition'];
    readonly runState: string;
    readonly attemptId: string | null;
    readonly whoseMove: {
      readonly kind: 'agent' | 'person';
      readonly actorId: string | null;
    } | null;
    readonly outcome: string | null;
    readonly fault: string | null;
    readonly lease: { readonly state: string; readonly expiresAt: string } | null;
    readonly effectObserved: boolean;
    /** Null when nothing is held or spent: absent money is never 0. */
    readonly heldMinor: number | null;
    readonly spentMinor: number | null;
    readonly currency: string;
  };
}

/** `task.receipt`: what an observed effect came from, and what it cost (T2c2, T2d). */
export interface ReceiptResult {
  readonly receipt: {
    readonly attemptId: string;
    readonly decision: { readonly id: string };
    readonly version: { readonly id: string; readonly number: number };
    readonly effect: { readonly kind: string; readonly audience: string };
    readonly settlement:
      | {
          readonly state: 'settled';
          readonly heldMinor: number;
          readonly spentMinor: number;
          readonly releasedMinor: number;
        }
      | { readonly state: string; readonly heldMinor: number };
  };
}

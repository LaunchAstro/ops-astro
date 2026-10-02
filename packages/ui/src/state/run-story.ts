// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of the agent's run story: its states, gate box and jobs. Moved whole
// from agent-run.ts to keep that file under the line limit; agent-run.ts
// re-exports every type here.

import type { RunCheck, RunVersion, UnknownAttempt } from './run-projection.ts';

export type RunTone = 'gate' | 'run' | 'done' | 'bad';

/** The run lifecycle's states, the unknown outcome and the drops included (CS-16.5). */
export type RunState =
  | 'at-gate'
  | 'gate-stale'
  | 'changes-requested'
  | 'approved'
  | 'running'
  | 'done'
  | 'unknown-outcome'
  | 'dropped'
  | 'rejected'
  | 'cancelled';

export type GateBox =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'armed' | 'stale' | 'decided';
      readonly gateId: string;
      readonly versionId: string;
      readonly version: number;
      readonly digest: string;
      readonly state: string;
      readonly round: number;
      readonly expiresAt: string | null;
      /** Why a stale gate went stale, in the pane's words. */
      readonly invalidatedBy: string | null;
    };

export type JobState =
  'done' | 'running' | 'waiting' | 'approved' | 'pending' | 'failed' | 'refused';

export interface Job {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  readonly state: JobState;
  /** Jobs sharing a group run in parallel and are drawn under one rule. */
  readonly group: string | null;
}

export interface RunStory {
  readonly lineageId: string;
  /** 1 for the oldest attempt on the task. */
  readonly attempt: number;
  readonly current: boolean;
  readonly state: RunState;
  readonly tone: RunTone;
  /** The state spill's word. */
  readonly word: string;
  /** The summary card's bold sentence. */
  readonly sentence: string;
  readonly progress: string;
  readonly currentJob: string;
  readonly blockedBy: string;
  readonly nextAction: string;
  readonly head: RunVersion;
  readonly gate: GateBox;
  readonly jobs: readonly Job[];
  readonly checks: readonly RunCheck[];
  /** Whether a permitted person may cancel it now: a live lineage not yet done. */
  readonly cancellable: boolean;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  /**
   * The attempt a person answers for (C54): the newest one, held with its
   * effect unknown. Null when there is none, or the read names no attempt id.
   */
  readonly unknownAttempt: UnknownAttempt | null;
}

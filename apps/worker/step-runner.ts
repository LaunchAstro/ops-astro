// SPDX-License-Identifier: AGPL-3.0-only
//
// The step runner the worker is given (#1623 R3). When dispatch refuses an
// accepted plan's lease `LAUNCH_NOT_DECIDED`, the worker runs the runner's
// `compute` there, under that lease and before any Launch. A `success` goes to
// the review handback, which records it; any other end stops the work there,
// with its outcome already recorded by the stop that ended it (the broker, a
// person's cancel, or the runner's own `run.end`). Nothing irreversible runs
// before a Launch: after it, the worker's own apply path runs unchanged.
//
// The worker has no runner of its own: the shipped one (`main.ts`) hands the
// agent's (#1717 R8b), and nothing here computes a plan with nothing (R8c).

import type { EndCode, RunOutcome } from '../../packages/core-wire/src/index.ts';
import type { Call } from './agent-call.ts';

/** What the runner computes under: the plan's work, and its agent calls under that work's credential. */
export interface StepContext {
  readonly phase: 'compute';
  readonly taskId: string;
  readonly attemptId: string;
  readonly lease: { readonly leaseId: unknown; readonly fence: unknown };
  readonly call: Call;
}

/** How a step's compute ended, as `outcomeOf` pairs them (design D1). */
export interface StepEnd {
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
}

export interface StepRunner {
  readonly compute: (context: StepContext) => Promise<StepEnd>;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The run's request shapes, a part of `CommandRequest` kept beside it so
// `requests.ts` stays under the per-file cap. Each names the task and the run
// on it, like the work controls.

import type { Envelope } from './request-envelope.ts';

export type RunRequest =
  // The answers at the budget stop (AW-05). The amount is in the currency's
  // minor units; the runtime checks both by value, so they are `unknown`
  // until it has.
  | ({
      readonly command: 'run.top_up';
      readonly recordId: string;
      readonly runId: string;
      readonly amountMinor: unknown;
      readonly currency: unknown;
    } & Envelope)
  | ({
      readonly command: 'run.end_at_budget_stop';
      readonly recordId: string;
      readonly runId: string;
    } & Envelope)
  // A run's state revised (MP-6-2): the version the caller read, and the
  // knowledge and unknowns the handler checks item by item.
  | ({
      readonly command: 'run.revise_state';
      readonly recordId: string;
      readonly runId: string;
      readonly expectedVersion: number;
      readonly knowledge: unknown;
      readonly unknowns: unknown;
    } & Envelope)
  // AW-11: served on the agent prefix only (`agent-child.ts`); the person
  // prefix refuses both by name.
  | ({ readonly command: 'run.delegate_child' } & Envelope)
  | ({ readonly command: 'run.child_handback' } & Envelope);

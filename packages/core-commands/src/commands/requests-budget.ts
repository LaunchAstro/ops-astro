// SPDX-License-Identifier: AGPL-3.0-only
//
// The money commands' request shapes, a part of `CommandRequest` kept beside
// it so `requests.ts` stays under the per-file cap. A person's decisions on
// `billing`; no agent route reaches any of them.

import type { Envelope } from './request-envelope.ts';

export type BudgetRequest =
  | ({
      readonly command: 'budget.top_up';
      readonly recordId: unknown;
      readonly amountMinor: number;
      readonly fromMaximumMinor: number;
    } & Envelope)
  | ({
      readonly command: 'budget.record_outcome';
      readonly recordId: unknown;
      readonly attemptId: unknown;
      readonly outcome: unknown;
    } & Envelope)
  | ({
      readonly command: 'budget.write_off';
      readonly recordId: unknown;
      readonly attemptId: unknown;
      readonly amountMinor: unknown;
      readonly reason: unknown;
    } & Envelope)
  // AW-04 (U10): the business's planning cap, against the limit last seen.
  | ({
      readonly command: 'budget.set_planning_cap';
      readonly limitMinor: number;
      readonly currency: string;
      readonly fromLimitMinor: number | null;
    } & Envelope);

// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: O3's exit mapping (docs/plan/sandbox-contract.md, O3 and R1).

import type { Reason, Why } from './refusal.ts';

export type RunEnd = {
  readonly statusCode: number;
  readonly oomKilled: boolean;
  readonly deadline: boolean;
  readonly output:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'output refused' | 'internal'; readonly why: Why };
};

export type RunOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: Extract<
        Reason,
        'memory' | 'deadline' | 'non-zero exit' | 'output refused' | 'internal'
      >;
    };

export function runOutcome(_end: RunEnd): RunOutcome {
  return { ok: true };
}

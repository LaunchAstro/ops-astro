// SPDX-License-Identifier: AGPL-3.0-only
//
// O3 (docs/plan/sandbox-contract.md, section 7): a run succeeds only with
// exit code 0, `State.OOMKilled` false, its deadline not reached and its
// output accepted. The reason named is the cause, not its effects: a
// daemon fault in the stream first, then `memory` (only when `OOMKilled`
// is true), then `deadline`, then `output refused` (a killed run's stream is
// cut short, so it reads as refused), then `non-zero exit`. stderr is kept
// for a person and is not an input here.

import type { Reason, Why } from './refusal.ts';

export type RunEnd = {
  readonly statusCode: number;
  readonly oomKilled: boolean;
  /** The run's B6 wall clock passed before its wait returned. */
  readonly deadline: boolean;
  /** The attach stream and the class's output grammar, read together. */
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

export function runOutcome(end: RunEnd): RunOutcome {
  if (!end.output.ok && end.output.reason === 'internal') return { ok: false, reason: 'internal' };
  if (end.oomKilled) return { ok: false, reason: 'memory' };
  if (end.deadline) return { ok: false, reason: 'deadline' };
  if (!end.output.ok) return { ok: false, reason: 'output refused' };
  if (end.statusCode !== 0) return { ok: false, reason: 'non-zero exit' };
  return { ok: true };
}

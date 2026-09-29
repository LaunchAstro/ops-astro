// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, the facts they are decided on (`budget-answer.ts`).
//
// An answer finds its rows first and takes no authority from what it finds.
// The grants are held `for share` before the locks, as decide.ts does, then
// the set is locked in the contract's order (cap, envelope, task, run,
// lineage, reservation) and every fact is read again under it: the run still
// waiting, its latest ask unanswered, the grant live at the locked instant.
// Two answers at once meet on the run lock, and the second finds the ask
// answered.

import type {
  CommandRefusal,
  DelegationRefusalCode,
  Subject,
} from '../../core-records/src/index.ts';
import type { RuntimeRefusalCode } from './refusals.ts';

/** Who answers, and the subjects the grant model reads for them. */
export interface BudgetAnswerRequest {
  readonly runId: string;
  readonly caller:
    | { readonly kind: 'person'; readonly personId: string; readonly actorId: string }
    | { readonly kind: 'agent'; readonly actorId: string };
  readonly subjects: readonly Subject[];
}

export type Person = Extract<BudgetAnswerRequest['caller'], { kind: 'person' }>;

/**
 * The runtime's refusals (the delegation's included), and the four registered
 * caller codes an answer produces: a person's decision under a delegation, a
 * run not in this business, a malformed amount, and a top-up that needs a
 * second person.
 */
export type BudgetAnswerCode =
  | RuntimeRefusalCode
  | DelegationRefusalCode
  | 'DELEGATION_EXCLUDES_DECISION'
  | 'NOT_FOUND'
  | 'FIELD_VALUE_INVALID'
  | 'FOUR_EYES_REQUIRED';

export type BudgetAnswerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CommandRefusal<BudgetAnswerCode> };

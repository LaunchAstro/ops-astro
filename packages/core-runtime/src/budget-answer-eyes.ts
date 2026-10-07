// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's top-up at the budget stop under the core's one four-eyes rule
// (`four-eyes.ts`, the rule T2e's top-up and T3c's write-off use): the band
// read under the answer's locks, and a first approval pairing only with a
// different person approving the same amount whose `billing:decide` on the
// run's task is live at the locked instant.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  approvalsOf,
  approverHolds,
  deny,
  invalid,
  thresholdOf,
  type Approval,
  type BudgetAnswerResult,
  type Opened,
} from './budget-answer-facts.ts';
import { holdFirstApprovers, pairFor, type FirstApprover, type Holds } from './four-eyes.ts';
import { checkAuthorityAt } from './recovery/classifier.ts';
import { refuse } from './refusals.ts';

/** The figure a top-up names: what a second approval must match. */
interface TopUpFigure {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface Eyes {
  readonly threshold: { readonly minor: number; readonly words: string } | null;
  readonly other: Approval | undefined;
  readonly mine: Approval | undefined;
  readonly completing: boolean;
}

/**
 * Who has approved, and whether this approval completes the top-up, by the
 * core's one four-eyes rule (`four-eyes.ts`): above the threshold a first
 * approval pairs only with a different person, approving the same amount,
 * whose `billing:decide` on the task is live at the locked instant. The plan
 * approver is one of the two where they hold the permission.
 */
export async function fourEyes(
  tx: TenantQuery,
  request: TopUpFigure,
  opened: Opened,
): Promise<BudgetAnswerResult<Eyes>> {
  const threshold = await thresholdOf(tx, opened.locked.currency);
  const pending = await approvalsOf(tx, opened.locked.ask_id);
  const me = opened.person.personId;
  const mine = pending.find((row) => row.person_id === me);
  const mismatch = otherAmount(pending, me, request);
  if (mismatch !== null) return mismatch;
  const firsts = asFirstApprovers(pending);
  await holdFirstApprovers(
    tx,
    firsts.filter((first) => first.personId !== me),
    'billing',
    'top-up at the budget stop',
  );
  const holds = billingHoldsAt(tx, opened);
  const band = threshold === null ? null : BigInt(threshold.minor);
  // The plan approver, while they hold the grant, is one of the two: their
  // waiting approval pairs before any earlier one.
  const approver = await approverHolds(tx, opened);
  const amount = BigInt(request.amountMinor);
  const paired = await pairFor(amount, band, me, firsts, holds, approver ?? undefined);
  if (paired === 'own') {
    return deny(
      'FOUR_EYES_REQUIRED',
      `a top-up above the four-eyes threshold of ${threshold?.words ?? ''} needs a second person, and you have approved it already`,
      'Another person holding billing:decide approves the same top-up.',
    );
  }
  const other = paired ?? undefined;
  const completing = paired !== undefined;
  const approvers = new Set([me, ...(other === undefined ? [] : [other.person_id])]);
  if (approver !== null && completing && !approvers.has(approver)) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'the plan approver still holds billing:decide, so the plan approver approves this top-up',
      'Ask the person who approved the plan.',
    );
  }
  return { ok: true, value: { threshold, other, mine, completing } };
}

/** A second approval is of the amount already approved, or none. */
function otherAmount(
  pending: readonly Approval[],
  me: string,
  request: TopUpFigure,
): BudgetAnswerResult<never> | null {
  const differs = pending.find(
    (row) =>
      row.person_id !== me &&
      (row.amount_minor !== String(request.amountMinor) || row.currency !== request.currency),
  );
  if (differs === undefined) return null;
  return invalid(
    'amountMinor',
    `A top-up of ${differs.amount_minor} ${differs.currency} is already approved and waits for a second person; approve that amount, or end the work.`,
  );
}

/** The ask's approvals as the one four-eyes rule reads them: each person, with their grant subjects. */
function asFirstApprovers(pending: readonly Approval[]): readonly (Approval & FirstApprover)[] {
  return pending.map((row) => ({
    id: row.id,
    person_id: row.person_id,
    actor_id: row.actor_id,
    amount_minor: row.amount_minor,
    currency: row.currency,
    personId: row.person_id,
    subjects: [
      { kind: 'person', id: row.person_id },
      { kind: 'actor', id: row.actor_id },
    ],
  }));
}

/** Whether subjects hold `billing:decide` on the run's task at the answer's locked instant. */
function billingHoldsAt(tx: TenantQuery, opened: Opened): Holds {
  const scope = {
    collection: 'billing',
    action: 'decide',
    scope: { kind: 'record', id: opened.locked.task_id },
  } as const;
  return async (subjects) => (await checkAuthorityAt(tx, subjects, scope, opened.lockedAt)).ok;
}

/** A first approval of the top-up's figure, by the answering person, for a second to pair with. */
export async function insertApproval(
  tx: TenantQuery,
  request: TopUpFigure & { readonly runId: string },
  { locked, person }: Opened,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.budget_approvals
       (business_id, id, ask_id, run_id, person_id, actor_id, amount_minor, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tx.businessId,
      id,
      locked.ask_id,
      request.runId,
      person.personId,
      person.actorId,
      request.amountMinor,
      request.currency,
    ],
  );
  return id;
}

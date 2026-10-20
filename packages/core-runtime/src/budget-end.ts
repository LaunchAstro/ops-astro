// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's end at a budget stop: one click ends the run, the stopped hold
// abandoned at its spend to date and the rest released, and the task parked.
// Its figures are minor units, carried as bigint and answered as decimal
// strings, exact past what a number holds. The top-up is `budget-answer.ts`.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { giveBackReleased } from '../../core-custody/src/index.ts';
import {
  openAnswer,
  type BudgetAnswerRequest,
  type BudgetAnswerResult,
  type Opened,
} from './budget-answer-facts.ts';
import { observedRefusal, releaseUnstarted, spentOn } from './budget-stop.ts';

/** Minor units as decimal strings, exact past what a number holds. */
export interface EndOutcome {
  readonly answerId: string;
  readonly releasedMinor: string;
  readonly spentMinor: string;
}

/** The stopped hold, still held: abandoned at its spend to date, the rest released. */
async function endHeld(
  tx: TenantQuery,
  locked: Opened['locked'],
  answerId: string,
): Promise<{ readonly releasedMinor: bigint; readonly spentMinor: bigint }> {
  const counted = await spentOn(tx, locked.reservation_id);
  await tx.query(
    `update public.reservations
        set state = 'abandoned', classified_cause = 'budget_stop_ended',
            classified_cause_id = $3, terminal_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, locked.reservation_id, answerId],
  );
  await tx.query(
    `update public.task_envelopes
        set held_minor = held_minor - $3, actual_minor = actual_minor + $4
      where business_id = $1 and id = $2`,
    [tx.businessId, locked.envelope_id, locked.held_minor, counted.spent.toString()],
  );
  // A call the sweep released since the count read it is spent no longer.
  const back = await giveBackReleased(tx, counted.unsent);
  return {
    releasedMinor: BigInt(locked.held_minor) - counted.spent + back,
    spentMinor: counted.spent - back,
  };
}

/** End the work at the budget stop: one click, the hold released, the task parked. */
export async function endAtBudgetStop(
  tx: TenantQuery,
  request: BudgetAnswerRequest,
): Promise<BudgetAnswerResult<EndOutcome>> {
  const opened = await openAnswer(tx, request, 'gate');
  if (!opened.ok) return opened;
  const { person, locked } = opened.value;
  const refused = await observedRefusal(tx, locked.reservation_state, locked.reservation_id);
  if (refused !== null) return refused;
  const answerId = randomUUID();
  await tx.query(
    `insert into public.budget_answers (business_id, id, ask_id, run_id, kind, first_person_id)
     values ($1, $2, $3, $4, 'end', $5)`,
    [tx.businessId, answerId, locked.ask_id, request.runId, person.personId],
  );
  // A hold a lineage cancel already classified is not released twice.
  const ended =
    locked.reservation_state === 'held'
      ? await endHeld(tx, locked, answerId)
      : { releasedMinor: 0n, spentMinor: 0n };
  const releasedMinor =
    ended.releasedMinor + (await releaseUnstarted(tx, request.runId, locked, answerId));
  await tx.query(
    `update public.planned_runs set state = 'cancelled' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return {
    ok: true,
    value: {
      answerId,
      releasedMinor: releasedMinor.toString(),
      spentMinor: ended.spentMinor.toString(),
    },
  };
}

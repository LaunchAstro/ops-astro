// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own lease stops at its ceiling, and that person observes the
// applied step at a priced cost above the hold, which is kept whole. A
// person then records `happened_differently`: the whole hold is spent and
// settled `completed` in that transaction, and the work reopens, so resume
// reserves its replacement. A top-up on the stop answers nothing then: the
// outcome was recorded after the stop, so the top-up is refused with words
// that say so, never that the step is finished, and nothing is written. The
// replacement stays held, and the end still answers the stop: it releases the
// unstarted replacement, so no hold is left for the cancelled work, and every
// table it changes, the replacement's attempt included, is one it declares.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { changed, fingerprint, undeclared } from '../operations/s0-5-effect-diff.ts';
import { appliedDetail, asPerson, codeOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, usePeople } from './budget-answers-world.ts';
import {
  answer,
  answerOf,
  observeOver,
  ONE_CALL,
  stateOf,
  stoppedAfterItsEffect,
} from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('reopened');
usePeople();

/** Each of the run's holds, oldest first: its state and amount. */
const holdsOf = async (runId: string) =>
  await s.db.admin.execute<{ state: string; held: string }>(
    `select state, held_minor::text as held from public.reservations
      where run_id = $1 order by created_at, id`,
    [runId],
  );

/** Room in the run's envelope for one more hold of the step, by a person's top-up. */
const roomForOneMore = async (taskId: string, runId: string) =>
  appliedDetail(
    await asPerson(s, {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: taskId,
      amountMinor: ONE_CALL,
      fromMaximumMinor: Number((await moneyOf(runId)).maximum),
    }),
    'budget.top_up',
  );

it('a top-up after the stopped step was recorded as happened differently is refused, saying why', async () => {
  await setThreshold(null);
  const { w, lease, runId, askId } = await stoppedAfterItsEffect();
  expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
  await roomForOneMore(w.taskId, runId);
  const recorded = await asPerson(s, {
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: w.taskId,
    attemptId: w.attemptId,
    outcome: 'happened_differently',
  });
  expect(codeOf(recorded)).toBe('applied');
  const before = { ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) };
  // The stopped hold is spent whole; the reopened work's replacement is held, the run waiting.
  expect(before).toMatchObject({
    run: 'waiting_budget',
    attempt: 'settled',
    answers: 0,
    approvals: 0,
  });
  expect(before.holds.map((hold) => hold.state)).toEqual(['actual', 'held']);
  expect(before.holds[1]?.held).toBe(String(ONE_CALL));

  const ask = { recordId: w.taskId, runId, askId };
  const topUp = { command: 'run.top_up', ...ask, amountMinor: 1_000, currency: 'AUD' };
  const refused = await answerOf(people.approver, topUp);
  expect(refused === 'applied' ? refused : refused.code).toBe('TRANSITION_NOT_PERMITTED');
  // Nothing written: no answer, no approval, no fresh hold, the envelope and the run as they were.
  expect({ ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) }).toEqual(before);
  const [why] = refused === 'applied' ? [] : refused.fixes;
  expect(why).toContain('recorded after the run stopped, so a top-up cannot apply');
  expect(why).not.toContain('finished');

  const unended = await fingerprint(s.db.admin);
  expect(await answer(people.second, { command: 'run.end_at_budget_stop', ...ask })).toBe(
    'applied',
  );
  const written = changed(unended, await fingerprint(s.db.admin));
  expect(written, 'the end reached the replacement').toContain('attempts');
  expect(undeclared('run.end_at_budget_stop', written)).toEqual([]);
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
  // The replacement never started: it is released, its 500 off the envelope and the cap.
  expect((await holdsOf(runId)).map((hold) => hold.state)).toEqual(['actual', 'abandoned']);
  const after = await moneyOf(runId);
  expect(Number(after.envelope_held)).toBe(Number(before.envelope_held) - ONE_CALL);
  expect(Number(after.cap_committed)).toBe(Number(before.cap_committed) - ONE_CALL);
  expect(after.envelope_actual).toBe(before.envelope_actual);
});

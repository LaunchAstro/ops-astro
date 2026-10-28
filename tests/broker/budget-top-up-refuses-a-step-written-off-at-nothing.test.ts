// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own lease stops at its ceiling after its effect applied, and the
// observation keeps the hold whole for a person. A write-off at nothing
// (`amountMinor: 0`) closes that hold and abandons the attempt, but says no
// more than a write-off above nothing about whether the step's effect
// happened. A top-up would hold the step afresh and run it again, so it is
// refused with nothing written, as it is after a write-off above nothing, and
// the end still answers the stop.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { asPerson, codeOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, usePeople } from './budget-answers-world.ts';
import {
  answer,
  holdsOf,
  observeOver,
  stateOf,
  stoppedAfterItsEffect,
} from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('offatzero');
usePeople();

it('a top-up after the stopped step was written off at nothing is refused, and the end still applies', async () => {
  await setThreshold(null);
  const { w, lease, runId, askId } = await stoppedAfterItsEffect();
  expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
  // A person charges nothing for the step without knowing whether its effect happened.
  const written = await asPerson(s, {
    command: 'budget.write_off',
    operationId: randomUUID(),
    recordId: w.taskId,
    attemptId: w.attemptId,
    amountMinor: 0,
    reason: 'Nothing to charge for the step; nobody can say whether it ran.',
  });
  expect(codeOf(written)).toBe('applied');
  const before = { ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) };
  expect(before).toMatchObject({ run: 'waiting_budget', attempt: 'abandoned', answers: 0 });

  const ask = { recordId: w.taskId, runId, askId };
  const topUp = { command: 'run.top_up', ...ask, amountMinor: 1_000, currency: 'AUD' };
  expect(await answer(people.approver, topUp)).toBe('TRANSITION_NOT_PERMITTED');
  // Nothing written: no fresh hold for a step whose effect is unknown, the run still waiting.
  expect({ ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) }).toEqual(before);

  expect(await answer(people.second, { command: 'run.end_at_budget_stop', ...ask })).toBe(
    'applied',
  );
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
});

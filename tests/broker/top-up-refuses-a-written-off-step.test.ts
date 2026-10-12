// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off closes a stopped step's hold with its effect still
// unknown: nobody observed whether the step ran. A top-up on that stop would
// hold the step afresh and run it again, so a step that may already have had
// its effect would have it twice. The top-up is refused with nothing written,
// whatever the amount written off, and the end still answers the stop.

import { expect, it as vitestIt } from 'vitest';
import { noDatabase, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, usePeople } from './budget-answers-world.ts';
import {
  answer,
  holdsOf,
  observeOver,
  stateOf,
  stoppedAfterItsEffect,
} from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('topupwrittenoff');
usePeople();

it.each([100, 0])(
  'a top-up after the stopped step was written off at %i is refused, and the end still applies',
  async (amountMinor) => {
    await setThreshold(null);
    const { w, lease, runId, askId } = await stoppedAfterItsEffect();
    expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
    const writeOff = {
      command: 'budget.write_off',
      recordId: w.taskId,
      attemptId: w.attemptId,
      amountMinor,
      reason: 'The provider never said whether the step ran.',
    };
    expect(await answer(people.approver, writeOff)).toBe('applied');
    const before = { ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) };
    expect(before).toMatchObject({ run: 'waiting_budget', answers: 0 });

    const ask = { recordId: w.taskId, runId, askId };
    const topUp = { command: 'run.top_up', ...ask, amountMinor: 1_000, currency: 'AUD' };
    expect(await answer(people.approver, topUp)).toBe('TRANSITION_NOT_PERMITTED');
    // Nothing written: no answer, no fresh hold for the written-off step, the run waiting.
    expect({ ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) }).toEqual(before);

    const end = { command: 'run.end_at_budget_stop', ...ask };
    expect(await answer(people.second, end)).toBe('applied');
    expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
  },
);

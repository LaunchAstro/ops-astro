// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the business requires the client's sign-off
// (`client_sign_off_required`), only a task with a client waits on it. A task
// with no client has no client to sign off, so agency approval releases its
// reviewed output: the launch decides and the dispatch marks the effect. A
// task with a client is still refused `CLIENT_SIGNOFF_REQUIRED` at both, with
// nothing decided or marked.

import { expect, it as vitestIt } from 'vitest';
import { gateOf, noDatabase, useAw04World, w } from './aw-04-world.ts';
import { dispatchAs, leased, marked, reviewed, setSignOff } from './aw-08-gate-world.ts';
import { linkClient } from './closed-stop-answer-world.ts';
import { appliedDetail, approveBody, asPerson, codeOf, pickup } from './schedules-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('signoffclient');

/** `body` run with the setting on, and the setting off again after it. */
async function withSignOffRequired(body: () => Promise<void>): Promise<void> {
  await setSignOff(w.alpha, true);
  try {
    await body();
  } finally {
    await setSignOff(w.alpha, false);
  }
}

it('with client sign-off required, a task with no client launches its reviewed output and dispatches the effect', async () => {
  await withSignOffRequired(async () => {
    const { taskId, proposal } = await reviewed(w.alpha);
    const decided = await asPerson(w.alpha, approveBody(proposal));
    expect(codeOf(decided)).toBe('applied');
    const picked = await pickup(w.alpha, appliedDetail(decided, 'task.decide')['reservationId']);
    const work = { taskId, proposal, picked, credential: String(picked['credential']) };
    expect(codeOf(await dispatchAs(w.alpha, work))).toBe('applied');
    expect(await marked(w.alpha, taskId)).toBe(1);
  });
});

it('with client sign-off required, a task with a client cannot launch: CLIENT_SIGNOFF_REQUIRED and nothing decided', async () => {
  await withSignOffRequired(async () => {
    const { taskId, proposal } = await reviewed(w.alpha);
    expect(await linkClient(w.alpha, taskId)).not.toBeNull();
    expect(codeOf(await asPerson(w.alpha, approveBody(proposal)))).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(await gateOf(w.alpha, proposal['gateId'])).toStrictEqual({
      state: 'pending',
      decisions: '0',
    });
  });
});

it('with client sign-off required after the launch, a task with a client is refused at dispatch and nothing is marked', async () => {
  const work = await leased(w.alpha, 'launch');
  expect(await linkClient(w.alpha, work.taskId)).not.toBeNull();
  await withSignOffRequired(async () => {
    expect(codeOf(await dispatchAs(w.alpha, work))).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(await marked(w.alpha, work.taskId)).toBe(0);
  });
});

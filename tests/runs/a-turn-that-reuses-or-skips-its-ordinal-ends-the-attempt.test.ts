// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the turn ordinal (design R4). Each turn carries `turnOrdinal`, and
// the broker requires it to equal the attempt's count of calls. A model
// rebuilt mid-attempt, whose counter went back to zero, cannot send turn 0
// again with new content: it is refused `TURN_ORDINAL_STALE` before any hold,
// and the attempt ends `cancelled`. So is an ordinal ahead of the count. The
// register's own replay stays apart: the same operation id with the same body
// answers the call it held, and with another body is `OPERATION_ID_REUSED`.
// Control: a new attempt starts its own ordinals at zero.

import { expect, it as vitestIt } from 'vitest';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  durable,
  noDatabase,
  s,
  signedIn,
  useDoorWorld,
  world,
  type SignedIn,
} from './run-stop-door-world.ts';
import { detailOf, firstTurn, replied, taskPart, turnBody, turnBroker } from './turn-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('r3ordinal', turnBroker(10));

/** Two turns on fresh work: the task, then the task again. The second turn's body. */
async function twoTurns(work: Work, as: SignedIn): Promise<Record<string, unknown>> {
  await firstTurn(work, as);
  world.provider.script([replied('Again.')]);
  const body = turnBody(work, 1, [await taskPart(work)]);
  const answer = await asAgent('/model/call', work, body, as);
  expect(detailOf(answer)['state'], JSON.stringify(answer.body)).toBe('settled');
  return body;
}

it.each([
  { name: 'turn 0 again, from a rebuilt model', ordinal: 0 },
  { name: 'an ordinal ahead of the count', ordinal: 5 },
])(
  '$name: refused TURN_ORDINAL_STALE before any hold, and the attempt ends',
  async ({ ordinal }) => {
    const work = await liveWork(s, `r3 ordinal ${String(ordinal)}`, 2_000);
    const as = await signedIn();
    await twoTurns(work, as);
    world.provider.script([replied('New content.')]);
    const seen = world.provider.seen.length;
    const body = turnBody(work, ordinal, [await taskPart(work)]);
    const answer = await asAgent('/model/call', work, body, as);
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('TURN_ORDINAL_STALE');
    expect(world.provider.seen.length).toBe(seen);
    const after = await durable(work);
    expect(after.calls).toEqual([
      { state: 'settled', refusal_code: null },
      { state: 'settled', refusal_code: null },
      { state: 'refused', refusal_code: 'TURN_ORDINAL_STALE' },
    ]);
    expect(after.outcomes).toMatchObject([
      { outcome: 'cancelled', end_code: 'TURN_ORDINAL_STALE', stop_cause: null },
    ]);
    expect(after.lease).toBe('released');
  },
  60_000,
);

it("the register's replay is apart: the same id and body answers its call; another body is refused", async () => {
  const work = await liveWork(s, 'r3 ordinal replay', 2_000);
  const as = await signedIn();
  const body = await twoTurns(work, as);
  const seen = world.provider.seen.length;
  const replayed = await asAgent('/model/call', work, body, as);
  expect(detailOf(replayed), JSON.stringify(replayed.body)).toMatchObject({ state: 'settled' });
  const reused = await asAgent(
    '/model/call',
    work,
    { ...body, parts: [{ ...(await taskPart(work)), revision: 0 }] },
    as,
  );
  expect(reused.body['code'], JSON.stringify(reused.body)).toBe('OPERATION_ID_REUSED');
  expect(world.provider.seen.length).toBe(seen);
  const after = await durable(work);
  expect(after.calls.map((call) => call.state)).toEqual(['settled', 'settled']);
  expect(after.lease).toBe('live');
}, 60_000);

it('control: a new attempt starts its own ordinals at zero', async () => {
  const before = await liveWork(s, 'r3 ordinal before', 2_000);
  await twoTurns(before, await signedIn());
  const work = await liveWork(s, 'r3 ordinal fresh', 2_000);
  await firstTurn(work, await signedIn());
  const after = await durable(work);
  expect(after.calls.map((call) => call.state)).toEqual(['settled']);
  expect(after.outcomes).toEqual([]);
}, 60_000);

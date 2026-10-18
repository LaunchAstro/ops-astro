// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the server's call limit (design R4 and F2), at limit 3 through the
// real agent door. The settlement of the limit-th call writes `call_limit /
// CALL_LIMIT_REACHED` and retires the work, whatever its answer: the answer
// still comes back, marked terminal, and a fourth call reserves nothing. A
// final answer at the limit is therefore never success. Control: an attempt
// that stops at two calls keeps its lease, with no outcome.

import { expect, it as vitestIt } from 'vitest';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  callBody,
  durable,
  noDatabase,
  s,
  signedIn,
  useDoorWorld,
  world,
} from './run-stop-door-world.ts';
import {
  answerPart,
  detailOf,
  readCall,
  replied,
  taskPart,
  turnBody,
  turnBroker,
} from './turn-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('r3limit', turnBroker(3));

const settledAt = (count: number) =>
  Array.from({ length: count }, () => ({ state: 'settled', refusal_code: null }));

async function expectCallLimit(work: Work): Promise<void> {
  const after = await durable(work);
  expect(after.outcomes).toMatchObject([
    { outcome: 'call_limit', end_code: 'CALL_LIMIT_REACHED', stop_cause: null },
  ]);
  expect(after.calls, 'three settlements and no fourth reserve').toEqual(settledAt(3));
  expect(after.lease).toBe('released');
  expect(after.delegationRevoked).toBe(true);
}

it('the third call of three settles, ends the attempt call_limit, and a fourth reserves nothing', async () => {
  const work = await liveWork(s, 'r3 limit fields', 2_000);
  const as = await signedIn();
  world.provider.mode('answer');
  for (const ordinal of [0, 1]) {
    // The calls are one after another by definition.
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent('/model/call', work, callBody(work), as);
    expect(detailOf(answer), `call ${String(ordinal)}`).toMatchObject({ state: 'settled' });
    expect(detailOf(answer)['terminal']).toBeUndefined();
  }
  const third = await asAgent('/model/call', work, callBody(work), as);
  expect(detailOf(third), JSON.stringify(third.body)).toMatchObject({
    state: 'settled',
    text: 'Drafted.',
    terminal: 'call_limit',
  });
  const seen = world.provider.seen.length;
  const fourth = await asAgent('/model/call', work, callBody(work), as);
  expect(fourth.body['code'], JSON.stringify(fourth.body)).toBe('DELEGATION_NOT_LIVE');
  expect(world.provider.seen.length).toBe(seen);
  await expectCallLimit(work);
}, 60_000);

it('a final answer exactly at the limit is call_limit, never success', async () => {
  const work = await liveWork(s, 'r3 limit turns', 2_000);
  const as = await signedIn();
  world.provider.script([
    replied('Reading.', [readCall(work, 'call_1')]),
    replied('Reading again.', [readCall(work, 'call_2')]),
    replied('Done.'),
  ]);
  const parts: unknown[] = [await taskPart(work)];
  let last: Readonly<Record<string, unknown>> = {};
  for (const ordinal of [0, 1, 2]) {
    // Each turn carries the answer before it.
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent('/model/call', work, turnBody(work, ordinal, parts), as);
    last = detailOf(answer);
    expect(last['state'], JSON.stringify(answer.body)).toBe('settled');
    // eslint-disable-next-line no-await-in-loop
    const result = await taskPart(work, { toolCallId: `call_${String(ordinal + 1)}` });
    parts.push(answerPart(last), result);
  }
  expect(last).toMatchObject({ text: 'Done.', toolCalls: [], terminal: 'call_limit' });
  await expectCallLimit(work);
}, 60_000);

it('control: an attempt that stops at two calls keeps its lease, with no outcome', async () => {
  const work = await liveWork(s, 'r3 limit control', 2_000);
  const as = await signedIn();
  world.provider.mode('answer');
  for (const _ of [0, 1]) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent('/model/call', work, callBody(work), as);
    expect(detailOf(answer)['terminal']).toBeUndefined();
  }
  const after = await durable(work);
  expect(after.outcomes).toEqual([]);
  expect(after.calls).toEqual(settledAt(2));
  expect(after.lease).toBe('live');
}, 60_000);

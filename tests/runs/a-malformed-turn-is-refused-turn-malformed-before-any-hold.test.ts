// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the broker's bounded turn parsers (design R7). A turn out of shape
// is refused `TURN_MALFORMED` before any hold or send, never re-asked, and the
// attempt ends `cancelled` with that code: parts that are not a list, more than
// 64 of them, a system part that is not first, a part with a key of its own, a
// tool result with no call before it or answered twice, a tool the catalogue
// does not offer, arguments over 16 KiB, an ordinal that is no whole number,
// and a body of the wrong kind for its operation, either way. A call outside
// its tool's schema never settles to be carried back: its answer is held
// (#2091, `a-malformed-or-unoffered-tool-call-runs-no-tool.test.ts`).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
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
  type SignedIn,
} from './run-stop-door-world.ts';
import { answerPart, firstTurn, taskPart, TURN, turnBody, turnBroker } from './turn-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('r3malformed', turnBroker(10));

type Body = Record<string, unknown>;

/** Turn 1's body after a turn 0 whose answer asked to read the task. */
async function afterFirst(
  work: Work,
  as: SignedIn,
  parts: (first: Readonly<Record<string, unknown>>) => Promise<readonly unknown[]>,
): Promise<Body> {
  const first = await firstTurn(work, as);
  return turnBody(work, 1, await parts(first));
}

const result = async (work: Work): Promise<Body> => await taskPart(work, { toolCallId: 'call_1' });

const CASES: readonly {
  readonly name: string;
  readonly calls: number;
  readonly body: (work: Work, as: SignedIn) => Body | Promise<Body>;
}[] = [
  {
    name: 'parts that are not a list',
    calls: 0,
    body: (work) => ({ ...turnBody(work, 0, []), parts: 'the task' }),
  },
  {
    name: 'more than 64 parts',
    calls: 0,
    body: (work) =>
      turnBody(
        work,
        0,
        Array.from({ length: 65 }, () => ({ ref: 'text' })),
      ),
  },
  {
    name: 'a system part that is not first',
    calls: 0,
    body: async (work) =>
      turnBody(work, 0, [
        await taskPart(work),
        { ref: 'definition', path: 'AGENTS.md', digest: '0'.repeat(64) },
      ]),
  },
  {
    name: 'a part with a key of its own',
    calls: 0,
    body: async (work) => turnBody(work, 0, [{ ...(await taskPart(work)), note: 'extra' }]),
  },
  {
    name: 'a tool result with no call before it',
    calls: 0,
    body: async (work) => turnBody(work, 0, [await taskPart(work), await result(work)]),
  },
  {
    name: 'a tool result answered twice',
    calls: 1,
    body: async (work, as) =>
      await afterFirst(work, as, async (first) => [
        await taskPart(work),
        answerPart(first),
        await result(work),
        await result(work),
      ]),
  },
  {
    name: 'a tool the catalogue does not offer',
    calls: 0,
    body: async (work) => turnBody(work, 0, [await taskPart(work)], ['task.read', 'task.delete']),
  },
  {
    name: 'tool arguments over 16 KiB',
    calls: 0,
    body: async (work) =>
      turnBody(work, 0, [
        await taskPart(work),
        {
          ref: 'answer',
          callId: randomUUID(),
          text: '',
          toolCalls: [{ id: 'call_1', name: 'task.read', args: { taskId: 'x'.repeat(17_000) } }],
        },
      ]),
  },
  {
    name: 'an ordinal that is no whole number',
    calls: 0,
    body: async (work) => ({ ...turnBody(work, 0, [await taskPart(work)]), turnOrdinal: 0.5 }),
  },
  {
    name: 'a turn to an operation that takes fields',
    calls: 0,
    body: async (work) => ({
      ...turnBody(work, 0, [await taskPart(work)]),
      operation: REPLAY_COMPOSE.key,
    }),
  },
  {
    name: 'fields to an operation that takes turns',
    calls: 0,
    body: (work) => callBody(work, TURN),
  },
];

it.each(CASES)(
  '$name: refused TURN_MALFORMED before any hold, and the attempt ends cancelled',
  async ({ name, calls, body }) => {
    const work = await liveWork(s, `r3 malformed ${name}`, 2_000);
    const as = await signedIn();
    const sent = await body(work, as);
    const seen = world.provider.seen.length;
    const answer = await asAgent('/model/call', work, sent, as);
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('TURN_MALFORMED');
    expect(world.provider.seen.length, 'nothing was sent').toBe(seen);
    const after = await durable(work);
    expect(after.calls.slice(0, calls).every((call) => call.state === 'settled')).toBe(true);
    expect(after.calls.slice(calls)).toEqual([
      { state: 'refused', refusal_code: 'TURN_MALFORMED' },
    ]);
    expect(after.outcomes).toMatchObject([
      { outcome: 'cancelled', end_code: 'TURN_MALFORMED', stop_cause: null },
    ]);
  },
  60_000,
);

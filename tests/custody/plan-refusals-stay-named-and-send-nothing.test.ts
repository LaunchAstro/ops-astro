// SPDX-License-Identifier: AGPL-3.0-only
//
// Each way a plan call can end short of an answer is named, and sends no
// more than P3 allows (#1620 P3, P4): the holder's refusal at prepare and at
// `present()` send nothing; the plan's 429 (its usage allowance) and 403 (this
// account refused) are one request each, never retried, and since the request
// was written they are held as unknown, never refused (#1926). The access token
// never appears in custody's stderr, in any reply, or in a refusal, even when
// the plan echoes it back.

import { afterEach, expect, it } from 'vitest';
import { completed, stream } from './fixtures/plan-answer-world.ts';
import {
  openPlanRouteWorld,
  planRequest,
  type PlanRouteWorld,
} from './fixtures/plan-route-world.ts';

let world: PlanRouteWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** Nothing custody said, wrote or answered holds the token: compared, never printed. */
function tokenNowhere(open: PlanRouteWorld, ...replies: unknown[]): void {
  const said = [open.custody.stderr(), ...replies.map((reply) => JSON.stringify(reply))];
  expect(said.some((text) => text.includes(open.token))).toBe(false);
}

it('a holder that refuses at prepare says why, carries no token, and the call after it sends nothing', async () => {
  world = await openPlanRouteWorld({ token: 'absent' });
  const prepared = await world.custody.prepare();
  expect(prepared).toStrictEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  const outcome = await world.dispatch(planRequest());
  expect(outcome).toStrictEqual({
    kind: 'refused',
    started: false,
    code: 'SUBSCRIPTION_REFRESH_FAILED',
  });
  expect(world.sent).toHaveLength(0);
  tokenNowhere(world, prepared, outcome);
}, 15_000);

it('a call with no prepared pair is refused at present() and sends nothing', async () => {
  world = await openPlanRouteWorld();
  const outcome = await world.dispatch(planRequest());
  expect(outcome).toMatchObject({ kind: 'refused', code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(world.sent).toHaveLength(0);
  tokenNowhere(world, outcome);
}, 15_000);

it('custody’s answer to prepare is the word and nothing else', async () => {
  world = await openPlanRouteWorld();
  const reply = await world.custody.raw({ type: 'prepare' });
  expect(Object.keys(reply).toSorted()).toStrictEqual(['id', 'type']);
  expect(reply['type']).toBe('prepared');
  tokenNowhere(world, reply);
}, 15_000);

it.each([429, 403] as const)(
  'a %s from the plan is one request, never retried, and held as unknown rather than refused',
  async (status) => {
    world = await openPlanRouteWorld();
    await world.custody.prepare();
    world.reply = () => ({ status, body: JSON.stringify({ error: { message: 'no' } }) });
    const outcome = await world.dispatch(planRequest());
    expect(outcome).toMatchObject({
      kind: 'answered',
      started: true,
      outbound: { ok: false, fault: 'status', status },
    });
    // A moment for any retry to arrive.
    await new Promise((done) => {
      setTimeout(done, 300);
    });
    expect(world.sent).toHaveLength(1);
    tokenNowhere(world, outcome);
  },
  15_000,
);

it('a plan that echoes the token in its answer has it judged out, and nothing custody says holds it', async () => {
  world = await openPlanRouteWorld();
  await world.custody.prepare();
  const echo = world.token;
  world.reply = () => ({
    status: 200,
    type: 'text/event-stream',
    body: stream(completed([`Your token is ${echo}.`])),
  });
  const outcome = await world.dispatch(planRequest());
  expect(world.sent).toHaveLength(1);
  tokenNowhere(world, outcome);
}, 15_000);

it('custody’s own reply to a refused or echoing plan call carries no token, read before the agent’s side', async () => {
  world = await openPlanRouteWorld();
  await world.custody.prepare();
  const echo = world.token;
  const replies: unknown[] = [];
  for (const reply of [
    { status: 429, body: '{}' },
    { status: 200, type: 'text/event-stream', body: stream(completed([`Token ${echo}.`])) },
  ]) {
    world.reply = () => reply;
    const request = planRequest();
    // oxlint-disable-next-line no-await-in-loop -- one call at a time
    replies.push(await world.custody.raw({ type: 'dispatch', credentialRef: 'x', request }));
  }
  expect(replies.map((reply) => (reply as { type?: unknown }).type)).toStrictEqual([
    'answer',
    'answer',
  ]);
  tokenNowhere(world, ...replies);
}, 15_000);

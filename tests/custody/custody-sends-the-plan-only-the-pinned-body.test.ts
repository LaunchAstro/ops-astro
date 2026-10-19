// SPDX-License-Identifier: AGPL-3.0-only
//
// What custody's real process writes to the plan's Responses endpoint
// (#1620 P4): exactly the body the agent checked, its keys the pinned five
// (and `tools`, when the call takes tools), no temperature or any other
// field, presented with the holder's token as a bearer to the one path. The
// stream is read whole: custody answers the folded completed response and
// passes no piece on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import { chatgptPlanBody, type PlanAsk } from '../../packages/core-connectors/src/index.ts';
import {
  ASK,
  TOOL,
  openPlanRouteWorld,
  planRequest,
  type PlanRouteWorld,
} from './fixtures/plan-route-world.ts';

const PINNED = ['input', 'instructions', 'model', 'store', 'stream'];

let world: PlanRouteWorld;
beforeAll(async () => {
  world = await openPlanRouteWorld();
  // Judged by each case: a call on an unprepared pair is refused.
  await world.custody.prepare();
});
afterAll(async () => {
  await world?.close();
});

/** The request for `ask`, admitted by the agent's check, then sent; the body the stand-in heard. */
async function captured(ask: PlanAsk): Promise<Record<string, unknown>> {
  const request = chatOf(planRequest(ask));
  if (request === undefined) throw new Error('the request check refused the case');
  const before = world.sent.length;
  const outcome = await world.dispatch(request);
  expect(outcome.kind).toBe('answered');
  expect(world.sent).toHaveLength(before + 1);
  const sent = world.sent.at(-1);
  expect(sent?.raw).toBe(chatgptPlanBody(ask));
  return JSON.parse(sent?.raw ?? '{}') as Record<string, unknown>;
}

describe('the captured plan request', () => {
  it('holds exactly the five pinned keys and no temperature', async () => {
    const body = await captured(ASK);
    expect(Object.keys(body).toSorted()).toStrictEqual(PINNED);
    expect(body).not.toHaveProperty('temperature');
    expect(body).toMatchObject({ store: false, stream: true });
  }, 15_000);

  it('holds the pinned five and tools when the call takes tools, each a strict function tool', async () => {
    const body = await captured({ ...ASK, tools: [TOOL] });
    expect(Object.keys(body).toSorted()).toStrictEqual([...PINNED, 'tools'].toSorted());
    expect(body).not.toHaveProperty('temperature');
    expect(body['tools']).toStrictEqual([
      {
        type: 'function',
        name: TOOL.name,
        description: TOOL.description,
        parameters: TOOL.parameters,
        strict: true,
      },
    ]);
  }, 15_000);

  it('goes by POST to the one path, the holder’s token presented as a bearer', async () => {
    await captured(ASK);
    const sent = world.sent.at(-1);
    expect(sent?.path).toBe('/v1/responses');
    expect(sent?.method).toBe('POST');
    // Compared, never printed.
    expect(sent?.authorization === `Bearer ${world.token}`).toBe(true);
  }, 15_000);
});

describe('the plan answer custody gives back', () => {
  it('is the folded completed response, with no piece passed on', async () => {
    world.pieces.length = 0;
    const outcome = await world.dispatch(planRequest());
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error(outcome.kind);
    const response = JSON.parse(outcome.outbound.body) as Record<string, unknown>;
    expect(response).toMatchObject({ id: 'resp_synthetic', status: 'completed' });
    expect(world.pieces).toStrictEqual([]);
    expect(outcome.outbound.body.includes(world.token)).toBe(false);
  }, 15_000);
});

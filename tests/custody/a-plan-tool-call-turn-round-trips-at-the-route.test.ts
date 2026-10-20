// SPDX-License-Identifier: AGPL-3.0-only
//
// A tool-call turn on the owner's ChatGPT plan, end to end at the route
// (#1620 P4): a request that offers a tool is admitted by the agent's check;
// the Responses stand-in streams a `function_call` then `response.completed`;
// custody's real process folds it, judged against the holder's secrets; and
// the chatgpt-plan answer reader gives the call back. A next turn carrying the
// call and its output is admitted too. The chat model's own case is #1715's.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import {
  readChatgptPlanAnswer,
  readChatgptPlanToolCalls,
} from '../../packages/core-connectors/src/index.ts';
import {
  ASK,
  TOOL,
  openPlanRouteWorld,
  planRequest,
  toolCallReply,
  type PlanRouteWorld,
} from './fixtures/plan-route-world.ts';

const ARGS = JSON.stringify({ text: 'Open weekdays 8 to 5.' });

let world: PlanRouteWorld;
beforeAll(async () => {
  world = await openPlanRouteWorld();
  // Judged by each case: a call on an unprepared pair is refused.
  await world.custody.prepare();
});
afterAll(async () => {
  await world?.close();
});

it('a request offering a tool is admitted, and the call it streams comes back through the reader', async () => {
  world.reply = () => toolCallReply(TOOL.name, ARGS);
  const request = chatOf(planRequest({ ...ASK, tools: [TOOL] }));
  if (request === undefined) throw new Error('the request check refused a request with tools');
  const outcome = await world.dispatch(request);
  if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error(outcome.kind);
  const body: unknown = JSON.parse(outcome.outbound.body);
  expect(readChatgptPlanToolCalls(body)).toStrictEqual([
    { callId: 'call_1', name: TOOL.name, arguments: ARGS },
  ]);
  expect(readChatgptPlanAnswer(body)).toMatchObject({
    text: '',
    model: 'gpt-6.1-sol',
    usage: { inputUnits: 12, outputUnits: 34 },
  });
  expect(world.sent).toHaveLength(1);
}, 15_000);

it('the next turn, carrying the call and its output, is admitted and sent as checked', async () => {
  world.reply = () => toolCallReply(TOOL.name, ARGS, 'call_2');
  const next = planRequest({
    ...ASK,
    tools: [TOOL],
    input: [
      ...ASK.input,
      { type: 'function_call', call_id: 'call_1', name: TOOL.name, arguments: ARGS },
      { type: 'function_call_output', call_id: 'call_1', output: 'Saved.' },
    ],
  });
  expect(chatOf(next)).toStrictEqual(next);
  const before = world.sent.length;
  const outcome = await world.dispatch(next);
  expect(outcome.kind).toBe('answered');
  expect(world.sent.at(-1)?.raw).toBe(next.body);
  expect(world.sent).toHaveLength(before + 1);
}, 15_000);

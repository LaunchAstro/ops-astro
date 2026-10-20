// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan's answer as it is sent today (register 284), end to end at the
// route: the Responses stand-in answers 200 with no content-type header and a
// `response.completed` whose output is empty, the words only in
// `response.output_item.done`. Custody's real process folds it and the
// chatgpt-plan answer reader gives the words back; the token never appears in
// the answer.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import { readChatgptPlanAnswer } from '../../packages/core-connectors/src/index.ts';
import { completed, sse } from './fixtures/plan-answer-world.ts';
import {
  openPlanRouteWorld,
  planRequest,
  type PlanRouteWorld,
} from './fixtures/plan-route-world.ts';

const WORDS = 'Open weekdays 8 to 5.';
const ITEM = {
  id: 'msg_1',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: WORDS, annotations: [] }],
};

let world: PlanRouteWorld;
beforeAll(async () => {
  world = await openPlanRouteWorld();
  await world.custody.prepare();
});
afterAll(async () => {
  await world?.close();
});

it('an answer with no content-type and its words only in a done item reaches the caller', async () => {
  world.reply = () => ({
    status: 200,
    type: null,
    body: sse([
      { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...ITEM, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: WORDS },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: WORDS },
      { type: 'response.output_item.done', output_index: 0, item: ITEM },
      { type: 'response.completed', response: { ...completed([]), output: [] } },
    ]),
  });
  const request = chatOf(planRequest());
  if (request === undefined) throw new Error('the request check refused the pinned request');
  const outcome = await world.dispatch(request);
  if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error(outcome.kind);
  expect(readChatgptPlanAnswer(JSON.parse(outcome.outbound.body))).toMatchObject({ text: WORDS });
  expect(outcome.outbound.body).not.toContain(world.token);
  expect(world.sent).toHaveLength(1);
}, 15_000);

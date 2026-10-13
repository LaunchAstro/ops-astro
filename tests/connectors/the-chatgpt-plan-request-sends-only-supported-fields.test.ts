// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan route's request and answer (#1620). The request is
// the public Responses endpoint's, stored nowhere and streamed: a model, the
// instructions, the turns, and tools in the shape the owner's one real call
// settles, and no field the plan does not take (no temperature, top_p, output
// cap or earlier response). Its streamed answer folds to the completed
// response, read for text, tool calls and usage. A 429 is the plan's
// allowance used up and a 403 a refusal, each by name and neither retried.

import { expect, it } from 'vitest';
import {
  CHATGPT_PLAN_ASKED_FIELDS,
  CHATGPT_PLAN_PATH,
  CHATGPT_PLAN_TURN,
  chatgptPlanRefusal,
  chatgptPlanRequest,
  readChatgptPlanAnswer,
  readChatgptPlanToolCalls,
  registerModelOperation,
} from '../../packages/core-connectors/src/index.ts';
import { foldResponses as foldResponsesStream } from '../../packages/core-custody/src/responses-fold.ts';

const lookUp = {
  name: 'task_read',
  description: 'Read the task this run works on.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

it('the request is the Responses call with store off, streaming on, and nothing else', () => {
  const request = chatgptPlanRequest({
    model: 'gpt-6.1-luna',
    instructions: 'Draft the correction.',
    input: [{ role: 'user', content: 'Fix the one word on the About page.' }],
    tools: [lookUp],
  });
  expect(request.path).toBe(CHATGPT_PLAN_PATH);
  expect(request.method).toBe('POST');
  const body = JSON.parse(request.body) as Record<string, unknown>;
  expect(Object.keys(body).toSorted()).toEqual([...CHATGPT_PLAN_ASKED_FIELDS].toSorted());
  expect(body['store']).toBe(false);
  expect(body['stream']).toBe(true);
  for (const unsupported of ['temperature', 'top_p', 'max_output_tokens', 'previous_response_id']) {
    expect(body).not.toHaveProperty(unsupported);
  }
});

it('with no tools the request names none', () => {
  const body = JSON.parse(
    chatgptPlanRequest({ model: 'gpt-6.1-luna', instructions: 'i', input: [] }).body,
  ) as Record<string, unknown>;
  expect(body).not.toHaveProperty('tools');
});

it('a function tool is top-level unless the real call settles it must be namespaced', () => {
  const ask = { model: 'gpt-6.1-luna', instructions: 'i', input: [], tools: [lookUp] };
  const top = JSON.parse(chatgptPlanRequest(ask, 'top_level').body) as { tools: unknown[] };
  expect(top.tools).toEqual([{ type: 'function', strict: false, ...lookUp }]);
  const spaced = JSON.parse(chatgptPlanRequest(ask, 'namespaced').body) as { tools: unknown[] };
  expect(spaced.tools).toEqual([
    { type: 'function', strict: false, ...lookUp, name: 'ops_astro__task_read' },
  ]);
});

const completed = {
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-6.1-luna',
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Draft ready.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'ops_astro__task_read', arguments: '{}' },
  ],
  usage: { input_tokens: 120, output_tokens: 8 },
};

const sse = [
  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Draft ' })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`,
].join('');

it('the streamed answer folds to its completed response, read for text, usage and tool calls', () => {
  const folded = foldResponsesStream(sse);
  expect(folded).toBeDefined();
  const response: unknown = JSON.parse(folded ?? '');
  expect(readChatgptPlanAnswer(response)).toEqual({
    text: 'Draft ready.',
    model: 'gpt-6.1-luna',
    usage: { inputUnits: 120, outputUnits: 8 },
    providerCode: null,
  });
  expect(readChatgptPlanToolCalls(response)).toEqual([
    { callId: 'call_1', name: 'task_read', arguments: '{}' },
  ]);
});

it('a stream with no completed response folds to nothing', () => {
  expect(foldResponsesStream(sse.split('event: response.completed')[0] ?? '')).toBeUndefined();
  expect(foldResponsesStream('not a stream')).toBeUndefined();
});

it('a 429 is the plan allowance used up and a 403 a refusal; neither is retried', () => {
  expect(chatgptPlanRefusal(429)).toBe('PLAN_ALLOWANCE_WAIT');
  expect(chatgptPlanRefusal(403)).toBe('SUBSCRIPTION_REFUSED');
  expect(chatgptPlanRefusal(500)).toBeUndefined();
  const declared = CHATGPT_PLAN_TURN.nothingHappened;
  expect(declared).toContain('PLAN_ALLOWANCE_WAIT');
  expect(declared).toContain('SUBSCRIPTION_REFUSED');
});

it('the plan turn registers as an operation', () => {
  expect(registerModelOperation(CHATGPT_PLAN_TURN).ok).toBe(true);
});

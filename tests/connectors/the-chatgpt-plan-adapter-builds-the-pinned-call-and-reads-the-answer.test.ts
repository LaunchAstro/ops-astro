// SPDX-License-Identifier: AGPL-3.0-only
//
// The chatgpt-plan route's adapter and answer reader (#1620 P4). The adapter
// builds the pinned Responses call through `chatgptPlanBody`, so the agent's
// check admits exactly what it builds. The reader takes custody's folded
// completed response: the output text joined, the usage counts and the model;
// the tool calls come back through a reader of their own, leaving the model
// answer's shape alone (#1715 widens it). The operation is unpriced, since the
// plan is already paid for, and settles once completed.

import { describe, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanAdapter,
  chatgptPlanBody,
  conversationInstructions,
  readChatgptPlanAnswer,
  readChatgptPlanToolCalls,
  registerModelOperation,
} from '../../packages/core-connectors/src/index.ts';
import { completed } from '../custody/fixtures/plan-answer-world.ts';

const VALUES = {
  page: JSON.stringify({ task: 't-1', title: 'About page hours' }),
  earlier: JSON.stringify([
    { role: 'person', body: 'Can you fix the hours?' },
    { role: 'agent', body: 'Which hours?' },
  ]),
  message: 'Weekdays 8 to 5.',
};

describe('the adapter', () => {
  it('builds the pinned call for the model asked for, and the agent admits it', () => {
    const built = chatgptPlanAdapter(VALUES, 'op-1', 'gpt-6.1-sol');
    expect(built).toStrictEqual({
      path: '/v1/responses',
      method: 'POST',
      body: chatgptPlanBody({
        model: 'gpt-6.1-sol',
        instructions: conversationInstructions('About page hours'),
        input: [
          { role: 'user', content: 'Can you fix the hours?' },
          { role: 'assistant', content: 'Which hours?' },
          { role: 'user', content: 'Weekdays 8 to 5.' },
        ],
      }),
    });
    const request = {
      destination: CHATGPT_PLAN_PROVIDER,
      ...built,
      timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
      maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
    };
    expect(chatOf(request)).toStrictEqual(request);
  });

  it('asks the smaller of the plan’s two models when none is named', () => {
    const body = JSON.parse(chatgptPlanAdapter(VALUES).body) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-6.1-luna');
  });
});

describe('the operation', () => {
  it('registers unpriced, to the plan, settling once completed, within the route’s bounds', () => {
    expect(registerModelOperation(CHATGPT_PLAN_CONVERSATION).ok).toBe(true);
    expect(CHATGPT_PLAN_CONVERSATION).toMatchObject({
      provider: CHATGPT_PLAN_PROVIDER,
      destination: CHATGPT_PLAN_PROVIDER,
      maximumMinor: 0,
      settlesAt: 'completed',
      timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
      maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
      billed: false,
    });
    expect(CHATGPT_PLAN_CONVERSATION.answer).toBe(readChatgptPlanAnswer);
  });
});

describe('the answer reader', () => {
  it('joins the output text, and reads the usage and the model', () => {
    expect(readChatgptPlanAnswer(completed(['Open ', 'weekdays.']))).toStrictEqual({
      text: 'Open weekdays.',
      model: 'gpt-6.1-sol',
      usage: { inputUnits: 12, outputUnits: 34 },
      providerCode: null,
    });
    expect(readChatgptPlanToolCalls(completed(['Open weekdays.']))).toStrictEqual([]);
  });

  it.each<[string, unknown]>([
    ['not an object', 'Open weekdays.'],
    ['no usage', { ...completed(['x']), usage: undefined }],
    ['no words and no call', completed([])],
    ['a model out of shape', { ...completed(['x']), model: 'a b' }],
  ])('finds no answer in %s', (_how, body) => {
    expect(readChatgptPlanAnswer(body)).toBeUndefined();
  });
});

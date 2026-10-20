// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan (#2091) as the model agent on the M5
// judges it: the request the turn adapter builds is admitted byte for byte by
// the real check (`chatOf`), within the route's wait and answer size, so the
// turn needs no check of its own: text only, and a round trip offering the
// plan its two tools with the model's earlier calls and their results
// (#2115). The same turn written any other way, carrying a field the plan's
// route does not take, a tool under its dotted catalogue name, or a result
// before its call, is refused before custody.

import { describe, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanTurnAdapter,
} from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';

const TASK = JSON.stringify({ title: 'About page hours', body: 'Fix the opening hours.' });

const VALUES = {
  turn: JSON.stringify([
    { role: 'user', text: TASK },
    { role: 'assistant', text: 'Draft: open 8 to 5.', toolCalls: [] },
    { role: 'user', text: TASK },
  ]),
  tools: JSON.stringify(['task.read', 'live_correction.request']),
};

const ROUND_TRIP = {
  turn: JSON.stringify([
    { role: 'user', text: TASK },
    {
      role: 'assistant',
      text: 'Reading the task.',
      toolCalls: [{ id: 'call_1', name: 'task.read', args: { taskId: 'task-1' } }],
    },
    { role: 'tool', toolCallId: 'call_1', text: TASK },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'call_2',
          name: 'live_correction.request',
          args: { taskId: 'task-1', page: 'about', word: 'nine', replacement: 'eight' },
        },
      ],
    },
    { role: 'tool', toolCallId: 'call_2', text: '{"correctionId":"k-1"}' },
  ]),
  tools: JSON.stringify(['task.read', 'live_correction.request']),
};

function requestOf(body: string): OutboundRequest {
  const built = chatgptPlanTurnAdapter(VALUES, 'call-1');
  return {
    destination: CHATGPT_PLAN_PROVIDER,
    path: built.path,
    method: built.method,
    body,
    timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
    maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
  };
}

describe('the M5 check on an agent turn', () => {
  it('admits the request the turn adapter builds, byte for byte', () => {
    const request = requestOf(chatgptPlanTurnAdapter(VALUES, 'call-1').body);
    expect(chatOf(request)).toStrictEqual(request);
    const body = JSON.parse(request.body);
    expect(body.input).toStrictEqual([
      { role: 'user', content: TASK },
      { role: 'assistant', content: 'Draft: open 8 to 5.' },
      { role: 'user', content: TASK },
    ]);
  });
});

describe('the M5 check on a round trip with tools', () => {
  it("admits the plan's tools, its calls and their results, byte for byte", () => {
    const request = requestOf(chatgptPlanTurnAdapter(ROUND_TRIP, 'call-1').body);
    expect(chatOf(request)).toStrictEqual(request);
    const body = JSON.parse(request.body);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toStrictEqual([
      'task_read',
      'live_correction_request',
    ]);
    expect(
      body.input.map((item: Record<string, string>) => item['type'] ?? item['role']),
    ).toStrictEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
      'function_call',
      'function_call_output',
    ]);
  });

  it('refuses the round trip with a dotted tool name, or a result before its call', () => {
    const body = JSON.parse(chatgptPlanTurnAdapter(ROUND_TRIP, 'call-1').body);
    const dotted = JSON.stringify({
      ...body,
      tools: body.tools.map((tool: Record<string, unknown>, i: number) =>
        i === 0 ? { ...tool, name: 'task.read' } : tool,
      ),
    });
    const [user, words, call, output, ...rest] = body.input;
    const early = JSON.stringify({ ...body, input: [user, words, output, call, ...rest] });
    for (const tampered of [dotted, early]) {
      expect(chatOf(requestOf(tampered))).toBeUndefined();
    }
  });
});

describe('the M5 check on a turn written another way', () => {
  it('refuses the same turn with its keys reordered, a temperature, or stored', () => {
    const body = JSON.parse(chatgptPlanTurnAdapter(VALUES, 'call-1').body);
    const { model, instructions, input } = body;
    const reordered = JSON.stringify({ instructions, model, input, store: false, stream: true });
    const warmer = JSON.stringify({ ...body, temperature: 0 });
    const stored = JSON.stringify({ ...body, store: true });
    for (const tampered of [reordered, warmer, stored]) {
      expect(chatOf(requestOf(tampered))).toBeUndefined();
    }
  });
});

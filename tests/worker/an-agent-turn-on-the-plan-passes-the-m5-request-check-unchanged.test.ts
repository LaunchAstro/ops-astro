// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan (#2091) as the model agent on the M5
// judges it: the request the turn adapter builds is admitted byte for byte by
// the real check (`chatOf`), within the route's wait and answer size, so the
// turn needs no check of its own. The same turn written any other way, or
// carrying a field the plan's route does not take, is refused before custody.

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

describe('the M5 check on a text-only agent turn', () => {
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

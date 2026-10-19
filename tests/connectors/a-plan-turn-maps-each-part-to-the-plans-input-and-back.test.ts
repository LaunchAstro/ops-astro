// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan (#2091): the broker's one `turn` field,
// its bound messages, becomes the pinned Responses call through
// `chatgptPlanBody`. The task and each later user part are user turns, an
// answer's words an assistant turn, and a bound system part, once #1904
// binds definitions, the instructions; with none, the pinned instructions
// stand. A turn offers its tools in the declared `tools` field, but text only
// (register 164) offers the plan none, so its body never carries `tools`.

import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_INSTRUCTIONS,
  CHATGPT_PLAN_DEFAULT_MODEL,
  CHATGPT_PLAN_PATH,
  chatgptPlanBody,
  chatgptPlanTurnAdapter,
} from '../../packages/core-connectors/src/index.ts';

const TASK = JSON.stringify({ title: 'About page hours', body: 'Fix the opening hours.' });
const TOOLS = JSON.stringify(['task.read', 'live_correction.request']);

const valuesOf = (messages: readonly Record<string, unknown>[], tools = TOOLS) => ({
  turn: JSON.stringify(messages),
  tools,
});

const pinned = (input: readonly { role: 'user' | 'assistant'; content: string }[]) =>
  chatgptPlanBody({
    model: CHATGPT_PLAN_DEFAULT_MODEL,
    instructions: AGENT_TURN_INSTRUCTIONS,
    input,
  });

describe('a turn as the plan takes it, text only', () => {
  it('sends the task part as the one user turn, under the pinned instructions', () => {
    const built = chatgptPlanTurnAdapter(valuesOf([{ role: 'user', text: TASK }]), 'call-1');
    expect(built).toStrictEqual({
      path: CHATGPT_PLAN_PATH,
      method: 'POST',
      body: pinned([{ role: 'user', content: TASK }]),
    });
    expect(AGENT_TURN_INSTRUCTIONS).not.toBe('');
  });

  it("keeps an earlier answer's words as an assistant turn, in order", () => {
    const messages = [
      { role: 'user', text: TASK },
      { role: 'assistant', text: 'Draft: open 8 to 5.', toolCalls: [] },
      { role: 'user', text: TASK },
    ];
    expect(chatgptPlanTurnAdapter(valuesOf(messages)).body).toBe(
      pinned([
        { role: 'user', content: TASK },
        { role: 'assistant', content: 'Draft: open 8 to 5.' },
        { role: 'user', content: TASK },
      ]),
    );
  });

  it('makes a bound system part the instructions, in place of the pinned ones', () => {
    const messages = [
      { role: 'system', text: 'Work the task as written.' },
      { role: 'user', text: TASK },
    ];
    expect(chatgptPlanTurnAdapter(valuesOf(messages)).body).toBe(
      chatgptPlanBody({
        model: CHATGPT_PLAN_DEFAULT_MODEL,
        instructions: 'Work the task as written.',
        input: [{ role: 'user', content: TASK }],
      }),
    );
  });

  it('offers the plan no tool, whatever the turn offered', () => {
    const body = JSON.parse(chatgptPlanTurnAdapter(valuesOf([{ role: 'user', text: TASK }])).body);
    expect(Object.keys(body)).toStrictEqual(['model', 'instructions', 'input', 'store', 'stream']);
    const none = chatgptPlanTurnAdapter(valuesOf([{ role: 'user', text: TASK }], '[]')).body;
    expect(none).toBe(pinned([{ role: 'user', content: TASK }]));
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan (#2091): the broker's one `turn` field,
// its bound messages, becomes the pinned Responses call through
// `chatgptPlanBody`. The task and each later user part are user turns, an
// answer's words an assistant turn, and a bound system part, once #1904
// binds definitions, the instructions; with none, the pinned instructions
// stand. The turn's declared `tools` field is what the plan is offered
// (#2115), each tool strict under the plan's name for it from the closed
// table; an answer's calls go back as `function_call` items under those
// names with canonical arguments, and each result as the
// `function_call_output` of its call. A name outside the table sends no input.

import { describe, expect, it } from 'vitest';
import { canonicalPayload } from '../../packages/core-digest/src/index.ts';
import {
  AGENT_TURN_INSTRUCTIONS,
  CHATGPT_PLAN_DEFAULT_MODEL,
  CHATGPT_PLAN_PATH,
  chatgptPlanBody,
  chatgptPlanTurnAdapter,
  readChatgptPlanTurnAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { completed } from '../custody/fixtures/plan-answer-world.ts';

const TASK = JSON.stringify({ title: 'About page hours', body: 'Fix the opening hours.' });
const TOOLS = JSON.stringify(['task.read', 'live_correction.request']);

const valuesOf = (messages: readonly Record<string, unknown>[], tools = TOOLS) => ({
  turn: JSON.stringify(messages),
  tools,
});

/** The plan's two tools, strict, as a turn offering both sends them. */
const PLAN_TOOLS = [
  {
    name: 'task_read',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'live_correction_request',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        page: { type: 'string' },
        word: { type: 'string' },
        replacement: { type: 'string' },
      },
      required: ['taskId', 'page', 'word', 'replacement'],
      additionalProperties: false,
    },
  },
];

const pinned = (input: Parameters<typeof chatgptPlanBody>[0]['input']) =>
  JSON.parse(
    chatgptPlanBody({
      model: CHATGPT_PLAN_DEFAULT_MODEL,
      instructions: AGENT_TURN_INSTRUCTIONS,
      input,
    }),
  );

/** The body built, with each offered tool's name and parameters only, its description set apart. */
function sent(values: Readonly<Record<string, string>>) {
  const body = JSON.parse(chatgptPlanTurnAdapter(values).body);
  const { tools, ...rest } = body;
  return {
    rest,
    tools: (tools ?? []).map((tool: Record<string, unknown>) => ({
      name: tool['name'],
      parameters: tool['parameters'],
    })),
    keys: Object.keys(body),
    toolKeys: (tools ?? []).map((tool: Record<string, unknown>) => Object.keys(tool)),
  };
}

describe('a turn as the plan takes it', () => {
  it('sends the task part as the one user turn, under the pinned instructions', () => {
    const built = chatgptPlanTurnAdapter(valuesOf([{ role: 'user', text: TASK }]), 'call-1');
    expect([built.path, built.method]).toStrictEqual([CHATGPT_PLAN_PATH, 'POST']);
    expect(sent(valuesOf([{ role: 'user', text: TASK }])).rest).toStrictEqual(
      pinned([{ role: 'user', content: TASK }]),
    );
    expect(AGENT_TURN_INSTRUCTIONS).not.toBe('');
  });

  it("keeps an earlier answer's words as an assistant turn, in order", () => {
    const messages = [
      { role: 'user', text: TASK },
      { role: 'assistant', text: 'Draft: open 8 to 5.', toolCalls: [] },
      { role: 'user', text: TASK },
    ];
    expect(sent(valuesOf(messages)).rest).toStrictEqual(
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
    expect(sent(valuesOf(messages)).rest).toStrictEqual(
      JSON.parse(
        chatgptPlanBody({
          model: CHATGPT_PLAN_DEFAULT_MODEL,
          instructions: 'Work the task as written.',
          input: [{ role: 'user', content: TASK }],
        }),
      ),
    );
  });
});

describe("a turn's tools as the plan takes them", () => {
  it("offers exactly the tools the turn offered, strict, under the plan's names", () => {
    const both = sent(valuesOf([{ role: 'user', text: TASK }]));
    expect(both.keys).toStrictEqual(['model', 'instructions', 'input', 'tools', 'store', 'stream']);
    expect(both.tools).toStrictEqual(PLAN_TOOLS);
    expect(both.toolKeys).toStrictEqual([
      ['type', 'name', 'description', 'parameters', 'strict'],
      ['type', 'name', 'description', 'parameters', 'strict'],
    ]);
    const one = sent(valuesOf([{ role: 'user', text: TASK }], JSON.stringify(['task.read'])));
    expect(one.tools).toStrictEqual([PLAN_TOOLS[0]]);
    const none = sent(valuesOf([{ role: 'user', text: TASK }], '[]'));
    expect(none.keys).toStrictEqual(['model', 'instructions', 'input', 'store', 'stream']);
    expect(none.rest).toStrictEqual(pinned([{ role: 'user', content: TASK }]));
  });

  it('sends no input when the turn offers a tool outside the table, or names one in a call', () => {
    const odd = sent(valuesOf([{ role: 'user', text: TASK }], JSON.stringify(['run.end'])));
    expect(odd.rest.input).toStrictEqual([]);
    const dotted = sent(valuesOf([{ role: 'user', text: TASK }], JSON.stringify(['task_read'])));
    expect(dotted.rest.input).toStrictEqual([]);
    const unnamed = sent(
      valuesOf([
        { role: 'user', text: TASK },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'run.end', args: {} }] },
      ]),
    );
    expect(unnamed.rest.input).toStrictEqual([]);
  });
});

describe("an answer's calls as the plan takes them, and back", () => {
  it("sends an answer's calls and their results in order, under the plan's names", () => {
    const args = { word: 'nine', taskId: 'task-1', replacement: 'eight', page: 'about' };
    const messages = [
      { role: 'user', text: TASK },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'task.read', args: { taskId: 'task-1' } },
          { id: 'call_2', name: 'live_correction.request', args },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', text: TASK },
      { role: 'tool', toolCallId: 'call_2', text: '{"correctionId":"k-1"}' },
    ];
    expect(sent(valuesOf(messages)).rest.input).toStrictEqual([
      { role: 'user', content: TASK },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'task_read',
        arguments: '{"taskId":"task-1"}',
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'live_correction_request',
        arguments: canonicalPayload(args),
      },
      { type: 'function_call_output', call_id: 'call_1', output: TASK },
      { type: 'function_call_output', call_id: 'call_2', output: '{"correctionId":"k-1"}' },
    ]);
  });
});

describe("the plan's calls, read back and sent again", () => {
  it("round-trips the plan's calls: read back, then sent on the next turn as the plan wrote them", () => {
    const written = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'live_correction_request',
      arguments: canonicalPayload({
        taskId: 'task-1',
        page: 'about',
        word: 'nine',
        replacement: 'eight',
      }),
      status: 'completed',
    };
    const answer = readChatgptPlanTurnAnswer(completed(['Fixing it.'], [written]));
    if (answer?.toolCalls === undefined) throw new Error('the call was not read');
    const next = sent(
      valuesOf([
        { role: 'user', text: TASK },
        { role: 'assistant', text: answer.text, toolCalls: answer.toolCalls },
        { role: 'tool', toolCallId: 'call_1', text: 'Asked.' },
      ]),
    );
    expect(next.rest.input).toStrictEqual([
      { role: 'user', content: TASK },
      { role: 'assistant', content: 'Fixing it.' },
      {
        type: 'function_call',
        call_id: written.call_id,
        name: written.name,
        arguments: written.arguments,
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'Asked.' },
    ]);
  });
});

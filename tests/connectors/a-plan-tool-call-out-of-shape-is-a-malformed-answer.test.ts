// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan's answer to an agent turn (#2115, gap 4): each `function_call`
// comes back as the catalogue's call, under the catalogue's name, its
// arguments parsed. A call out of shape refuses the whole answer, which
// settlement holds as malformed, so no call reaches the runner: a name
// outside the closed table (a dotted catalogue name included), arguments
// that are not a JSON object of exactly the tool's operands, each a string
// of 1 to 4,096 units within 16 KiB, or a call id out of shape or repeated.
// Arguments no canonical payload can hold (a number past any number) are
// malformed too, never a throw.
// Words alone are the answer, with no tool calls.

import { describe, expect, it } from 'vitest';
import { readChatgptPlanTurnAnswer } from '../../packages/core-connectors/src/index.ts';
import { completed } from '../custody/fixtures/plan-answer-world.ts';

const TASK = '00000000-0000-4000-8000-000000000001';
const REQUEST = { taskId: TASK, page: 'about', word: 'nine', replacement: 'eight' };

const call = (name: string, args: string, callId = 'call_1') => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
  status: 'completed',
});

const read = (callId = 'call_1') => call('task_read', JSON.stringify({ taskId: TASK }), callId);
const ask = (args: unknown = REQUEST, callId = 'call_2') =>
  call('live_correction_request', JSON.stringify(args), callId);

describe('a turn answer with calls', () => {
  it('is the words alone, with no tool calls, when the plan called nothing', () => {
    expect(readChatgptPlanTurnAnswer(completed(['Open 8 to 5', ' on weekdays.']))).toStrictEqual({
      text: 'Open 8 to 5 on weekdays.',
      model: 'gpt-6.1-sol',
      usage: { inputUnits: 12, outputUnits: 34 },
      providerCode: null,
    });
  });

  it("gives each call back under the catalogue's name, in order, beside the words", () => {
    const answer = readChatgptPlanTurnAnswer(completed(['Reading first.'], [read(), ask()]));
    expect(answer).toStrictEqual({
      text: 'Reading first.',
      model: 'gpt-6.1-sol',
      usage: { inputUnits: 12, outputUnits: 34 },
      providerCode: null,
      toolCalls: [
        { id: 'call_1', name: 'task.read', args: { taskId: TASK } },
        { id: 'call_2', name: 'live_correction.request', args: REQUEST },
      ],
    });
  });

  it('keeps a call with no words', () => {
    expect(readChatgptPlanTurnAnswer(completed([], [read()]))).toMatchObject({
      text: '',
      toolCalls: [{ id: 'call_1', name: 'task.read', args: { taskId: TASK } }],
    });
  });
});

const MALFORMED: readonly (readonly [string, readonly Record<string, unknown>[]])[] = [
  ['a dotted catalogue name', [call('task.read', JSON.stringify({ taskId: TASK }))]],
  ['a tool outside the table', [call('run_end', JSON.stringify({ taskId: TASK }))]],
  ['a name in another case', [call('Task_Read', JSON.stringify({ taskId: TASK }))]],
  ['arguments that are not JSON', [call('task_read', '{not json')]],
  ['arguments that are a list', [call('task_read', JSON.stringify([TASK]))]],
  ['arguments that are null', [call('task_read', 'null')]],
  ['arguments that are a string', [call('task_read', JSON.stringify(TASK))]],
  ['a task id past any number', [call('task_read', '{"taskId":1e999}')]],
  ['a read with an extra key', [call('task_read', JSON.stringify({ taskId: TASK, extra: 'x' }))]],
  ['a correction missing a key', [ask({ taskId: TASK, page: 'about', word: 'nine' })]],
  ['a word that is a number', [ask({ ...REQUEST, word: 9 })]],
  ['a page that is an object', [ask({ ...REQUEST, page: { injected: true } })]],
  ['an empty task id', [ask({ ...REQUEST, taskId: '' })]],
  ['a word past 4,096 units', [ask({ ...REQUEST, word: 'a'.repeat(4097) })]],
  [
    'arguments past 16 KiB',
    [ask({ ...REQUEST, page: 'é'.repeat(4096), word: 'é'.repeat(4096), replacement: 'é' })],
  ],
  ['an empty call id', [read('')]],
  ['a call id with a space', [read('call 1')]],
  ['a call id of 129 characters', [read('c'.repeat(129))]],
  ['a call id twice', [read('call_1'), ask(REQUEST, 'call_1')]],
  ['a good call beside a bad sibling', [read(), ask({ ...REQUEST, replacement: false })]],
];

describe('a turn answer with a call out of shape', () => {
  it.each(MALFORMED)('is malformed: %s', (_name, calls) => {
    expect(readChatgptPlanTurnAnswer(completed(['Done.'], calls))).toBeUndefined();
    expect(readChatgptPlanTurnAnswer(completed([], calls))).toBeUndefined();
  });

  it('control: a call id of 128 characters is kept', () => {
    expect(readChatgptPlanTurnAnswer(completed([], [read('c'.repeat(128))]))).toBeDefined();
  });
});

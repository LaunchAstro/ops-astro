// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan, text only (#2091, register 164): the
// plan is offered no tool, so a completed response holding any
// `function_call`, with words beside it or without, is no answer this turn
// takes. The reader gives back nothing, which settlement holds as malformed,
// and no call ever reaches the runner. Words alone are the answer, with no
// tool calls.

import { describe, expect, it } from 'vitest';
import { readChatgptPlanTurnAnswer } from '../../packages/core-connectors/src/index.ts';
import { completed } from '../custody/fixtures/plan-answer-world.ts';

const CALL = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'live_correction_request',
  arguments: JSON.stringify({ taskId: 't-1', page: 'about', word: 'nine', replacement: 'eight' }),
  status: 'completed',
};

describe('a text-only turn answer', () => {
  it('is the words alone, with no tool calls', () => {
    expect(readChatgptPlanTurnAnswer(completed(['Open 8 to 5', ' on weekdays.']))).toStrictEqual({
      text: 'Open 8 to 5 on weekdays.',
      toolCalls: [],
      model: 'gpt-6.1-sol',
      usage: { inputUnits: 12, outputUnits: 34 },
      providerCode: null,
    });
  });

  it('is malformed when the plan called a tool beside its words', () => {
    expect(readChatgptPlanTurnAnswer(completed(['Done.'], [CALL]))).toBeUndefined();
  });

  it('is malformed when the plan called a tool and said nothing', () => {
    expect(readChatgptPlanTurnAnswer(completed([], [CALL]))).toBeUndefined();
  });

  it('is malformed when the call is out of shape, as any call is', () => {
    const odd = { ...CALL, arguments: '{not json' };
    expect(readChatgptPlanTurnAnswer(completed(['Done.'], [odd]))).toBeUndefined();
  });
});

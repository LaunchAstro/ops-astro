// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker judges every tool call a turn carries, and every call an answer
// asks for, against the catalogue's operands (#2091, gap v2-1): each operand
// a string of 1 to 4,096 units, the keys exactly the tool's. A correction
// whose page, word or replacement is not a string never passes, whether it
// comes back in an answer (before the runner sees it) or is carried on a
// later turn. An answer is judged whole: one bad call refuses all of it. Its
// calls must name tools this turn offered, each id once and new to the turn.

import { describe, expect, it } from 'vitest';
import {
  answerCallsKept,
  readTurn,
  toolsKept,
} from '../../packages/core-custody/src/broker-turn-read.ts';
import { ARGUMENT_CASES } from './agent-tool-argument-cases.ts';

const TASK = '00000000-0000-4000-8000-000000000001';
const TOOLS = ['task.read', 'live_correction.request'];

const turnWith = (calls: readonly unknown[], tools = TOOLS) => {
  const turn = readTurn({
    turnOrdinal: 1,
    tools,
    parts: [
      { ref: 'task', taskId: TASK, revision: 1 },
      { ref: 'answer', callId: 'a1', text: '', toolCalls: calls },
    ],
  });
  if (turn === undefined) throw new Error('the turn is out of shape');
  return turn;
};

const first = readTurn({
  turnOrdinal: 0,
  tools: TOOLS,
  parts: [{ ref: 'task', taskId: TASK, revision: 1 }],
});

describe('each tool argument, at the broker', () => {
  it.each(ARGUMENT_CASES)(
    '$name is kept: $kept, carried on a later turn',
    ({ tool, args, kept }) => {
      expect(toolsKept(turnWith([{ id: 'c1', name: tool, args }]))).toBe(kept);
    },
  );

  it.each(ARGUMENT_CASES)(
    '$name is kept: $kept, asked for in an answer',
    ({ tool, args, kept }) => {
      if (first === undefined) throw new Error('the turn is out of shape');
      expect(answerCallsKept(first, [{ id: 'c1', name: tool, args }])).toBe(kept);
    },
  );
});

describe('an answer, judged whole', () => {
  if (first === undefined) throw new Error('the turn is out of shape');
  const read = { id: 'c1', name: 'task.read', args: { taskId: TASK } };

  it('refuses a good call beside a bad sibling', () => {
    const bad = { id: 'c2', name: 'task.read', args: { taskId: TASK, extra: 1 } };
    expect(answerCallsKept(first, [read])).toBe(true);
    expect(answerCallsKept(first, [read, bad])).toBe(false);
  });

  it('refuses a tool this turn did not offer', () => {
    const offered = readTurn({
      turnOrdinal: 0,
      tools: ['live_correction.request'],
      parts: [{ ref: 'task', taskId: TASK, revision: 1 }],
    });
    if (offered === undefined) throw new Error('the turn is out of shape');
    expect(answerCallsKept(offered, [read])).toBe(false);
  });

  it('refuses an id twice in the answer, or one an earlier answer used', () => {
    expect(answerCallsKept(first, [read, { ...read }])).toBe(false);
    const later = turnWith([read]);
    expect(answerCallsKept(later, [{ ...read, id: 'c9' }])).toBe(true);
    expect(answerCallsKept(later, [read])).toBe(false);
  });

  it('keeps an answer with no calls', () => {
    expect(answerCallsKept(first, [])).toBe(true);
  });
});

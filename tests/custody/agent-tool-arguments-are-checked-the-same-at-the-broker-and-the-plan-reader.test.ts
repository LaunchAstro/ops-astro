// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's tool arguments are judged the same on both sides of the plan
// (#2115, gap v2-1): the broker's check of an answer's calls and the plan
// reader's check of the plan's `function_call` items run one shared table of
// cases, each with its expected outcome, so the two can't drift. The plan's
// tools are offered with the catalogue's operands exactly, all required.

import { describe, expect, it } from 'vitest';
import {
  chatgptPlanTurnAdapter,
  readChatgptPlanTurnAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { answerCallsKept, readTurn } from '../../packages/core-custody/src/broker-turn-read.ts';
import { declarationOf } from '../../packages/core-wire/src/index.ts';
import { ARGUMENT_CASES } from '../broker/agent-tool-argument-cases.ts';
import { completed } from './fixtures/plan-answer-world.ts';

const TASK = '00000000-0000-4000-8000-000000000001';
const TOOLS = ['task.read', 'live_correction.request'];
const PLAN_NAMES: Readonly<Record<string, string>> = {
  'task.read': 'task_read',
  'live_correction.request': 'live_correction_request',
};

const first = readTurn({
  turnOrdinal: 0,
  tools: TOOLS,
  parts: [{ ref: 'task', taskId: TASK, revision: 1 }],
});

/** The plan's answer asking for `tool` with `args`, under the plan's name for it. */
const planAnswer = (tool: string, args: Readonly<Record<string, unknown>>) =>
  completed(
    [],
    [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: PLAN_NAMES[tool],
        arguments: JSON.stringify(args),
        status: 'completed',
      },
    ],
  );

describe('each tool argument, at the broker and at the plan reader', () => {
  it.each(ARGUMENT_CASES)('$name is kept: $kept by both', ({ tool, args, kept }) => {
    if (first === undefined) throw new Error('the turn is out of shape');
    const broker = answerCallsKept(first, [{ id: 'call_1', name: tool, args }]);
    const read = readChatgptPlanTurnAnswer(planAnswer(tool, args));
    expect({ broker, plan: read !== undefined }).toStrictEqual({ broker: kept, plan: kept });
    if (kept) expect(read?.toolCalls).toStrictEqual([{ id: 'call_1', name: tool, args }]);
  });
});

describe("the plan's tools", () => {
  it("are offered with each catalogue tool's operands exactly, every one a required string", () => {
    const built = chatgptPlanTurnAdapter({
      turn: JSON.stringify([{ role: 'user', text: 'the task' }]),
      tools: JSON.stringify(TOOLS),
    });
    const offered = JSON.parse(built.body).tools as { name: string; parameters: unknown }[];
    const operands: Readonly<Record<string, readonly string[]>> = {
      'task.read': ['taskId'],
      'live_correction.request': Object.keys(
        declarationOf('live_correction.request').operands ?? {},
      ),
    };
    expect(operands['live_correction.request']).toStrictEqual([
      'taskId',
      'page',
      'word',
      'replacement',
    ]);
    expect(offered.map((tool) => [tool.name, tool.parameters])).toStrictEqual(
      TOOLS.map((tool) => [
        PLAN_NAMES[tool],
        {
          type: 'object',
          properties: Object.fromEntries(
            (operands[tool] ?? []).map((key) => [key, { type: 'string' }]),
          ),
          required: operands[tool],
          additionalProperties: false,
        },
      ]),
    );
  });
});

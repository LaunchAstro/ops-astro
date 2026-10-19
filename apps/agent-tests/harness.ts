// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent test harness (#1626 R11). It runs each case of a set through
// `core-agent`'s loop, `runAttempt`, with the replay fake as its model: each
// turn goes to the fake on loopback through the replay adapter, its parts
// made into messages as the broker makes them (the task, the page `task.read`
// returned, the answers kept), and its answer is read against the replay
// schema, as the broker reads it. No database, no credential and no host
// beyond loopback is reached, so a set gives the same results on every run.
//
// A case passes when its attempt ends in the code it expects and, when it
// finishes, its final answer holds what it must and leaves out what it must
// not. The fake's 429 stands for the plan's allowance running out, which
// the plan route records as `LOCAL_PLAN_LIMIT` (R12 wires the real route).

import {
  attemptState,
  runAttempt,
  type AttemptPorts,
  type Turn,
  type TurnAnswer,
} from '../../packages/core-agent/src/index.ts';
import {
  readReplayAnswer,
  replayAdapter,
  REPLAY_MODEL_WINDOW,
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import type {
  EndCode,
  RunOutcome,
  ToolCall,
  TurnPart,
} from '../../packages/core-wire/src/index.ts';

/** What the fake answers one turn with: words and tool calls, or the plan's allowance gone. */
export type Reply =
  | { readonly text: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly fault: 'rate_limited' };

export interface AgentCase {
  readonly id: string;
  readonly task: string;
  /** What the agent's one tool, `task.read`, returns. */
  readonly page: string;
  /** The attempt's call limit. */
  readonly limit: number;
  readonly replies: readonly Reply[];
  readonly expect: {
    readonly endCode: EndCode;
    readonly includes?: string;
    readonly excludes?: string;
  };
}

export interface CaseSet {
  readonly name: string;
  /** The model the set is written for, on the plan. */
  readonly target: string;
  readonly cases: readonly AgentCase[];
}

export interface Usage {
  readonly inputUnits: number;
  readonly outputUnits: number;
}

export interface CaseResult {
  readonly id: string;
  /** The model the answers named; null when none came. */
  readonly model: string | null;
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
  readonly expected: EndCode;
  readonly passed: boolean;
  readonly turns: number;
  readonly usage: Usage;
}

export interface Results {
  readonly set: string;
  readonly target: string;
  readonly provider: 'replay';
  readonly passed: number;
  readonly failed: number;
  readonly usage: Usage;
  readonly cases: readonly CaseResult[];
}

const TASK_ID = '00000000-0000-4000-8000-0000000000c1';
const REVISION = 1;

interface Answered {
  readonly model: string | null;
  readonly text: string;
  readonly usage: Usage;
}

const sum = (usages: readonly Usage[]): Usage => ({
  inputUnits: usages.reduce((total, usage) => total + usage.inputUnits, 0),
  outputUnits: usages.reduce((total, usage) => total + usage.outputUnits, 0),
});

/** A turn's part as the message the model reads; the harness gives no definition part. */
function messageOf(one: AgentCase, part: TurnPart): Readonly<Record<string, unknown>> {
  if (part.ref === 'answer')
    return { role: 'assistant', text: part.text, toolCalls: part.toolCalls };
  if (part.ref === 'definition') throw new Error('the harness sends no definition part');
  return part.toolCallId === undefined
    ? { role: 'user', text: one.task }
    : { role: 'tool', toolCallId: part.toolCallId, text: one.page };
}

/** One turn sent to the fake, answered with the reply the case gives it. */
async function send(
  provider: ReplayProvider,
  one: AgentCase,
  turn: Turn,
  answered: Answered[],
): Promise<TurnAnswer> {
  const reply = one.replies[turn.turnOrdinal];
  if (reply !== undefined && 'fault' in reply) {
    provider.mode(reply.fault);
  } else {
    provider.mode('answer');
    provider.script(
      reply === undefined
        ? []
        : [
            {
              text: reply.text,
              model: REPLAY_MODEL_WINDOW.model,
              usage: { input: 40, output: 30 },
              tool_calls: reply.toolCalls ?? [],
            },
          ],
    );
  }
  const callId = `${one.id}:${String(turn.turnOrdinal)}`;
  const messages = turn.parts.map((part) => messageOf(one, part));
  const request = replayAdapter({ turn: JSON.stringify(messages) }, callId);
  const response = await fetch(`${provider.origin}${request.path}`, {
    method: request.method,
    body: request.body,
  });
  if (response.status === 429) return { stopped: 'LOCAL_PLAN_LIMIT', recorded: true };
  const read = response.ok ? readReplayAnswer(await response.json()) : undefined;
  if (read === undefined) return { stopped: 'ANSWER_LOST', recorded: false };
  answered.push({ model: read.model, text: read.text, usage: read.usage });
  return { callId, text: read.text, toolCalls: read.toolCalls ?? [] };
}

async function runCase(provider: ReplayProvider, one: AgentCase): Promise<CaseResult> {
  const answered: Answered[] = [];
  let turns = 0;
  const ports: AttemptPorts = {
    broker: {
      turn: async (turn) => {
        turns += 1;
        return await send(provider, one, turn, answered);
      },
    },
    tools: new Map([
      ['task.read', async () => await Promise.resolve({ revision: REVISION, content: one.page })],
    ]),
    end: async () => await Promise.resolve(),
  };
  const state = attemptState(TASK_ID, REVISION, ['task.read']);
  const end = await runAttempt(state, ports, one.limit, undefined, one.task);
  const text = answered.at(-1)?.text ?? '';
  const { endCode, includes, excludes } = one.expect;
  const passed =
    end.endCode === endCode &&
    (end.outcome !== 'success' ||
      ((includes === undefined || text.includes(includes)) &&
        (excludes === undefined || !text.includes(excludes))));
  return {
    id: one.id,
    model: answered.at(-1)?.model ?? null,
    outcome: end.outcome,
    endCode: end.endCode,
    expected: endCode,
    passed,
    turns,
    usage: sum(answered.map((answer) => answer.usage)),
  };
}

/** Every case of a set, one after another, on one replay fake. */
export async function runSet(set: CaseSet): Promise<Results> {
  const provider = await startReplayProvider();
  try {
    const cases: CaseResult[] = [];
    for (const one of set.cases) {
      // oxlint-disable-next-line no-await-in-loop -- one fake, scripted one case at a time
      cases.push(await runCase(provider, one));
    }
    const passed = cases.filter((result) => result.passed).length;
    return {
      set: set.name,
      target: set.target,
      provider: 'replay',
      passed,
      failed: cases.length - passed,
      usage: sum(cases.map((result) => result.usage)),
      cases,
    };
  } finally {
    await provider.close();
  }
}

/** A parsed file is a results file: the shape `runSet` writes. */
export const isResults = (value: unknown): value is Results =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<Results>).provider === 'replay' &&
  typeof (value as Partial<Results>).set === 'string' &&
  Array.isArray((value as Partial<Results>).cases);

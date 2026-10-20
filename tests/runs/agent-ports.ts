// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #1623 R4 agent proofs share: `core-agent`'s loop on the pinned
// stack, its broker a scripted port. Each turn is kept as it was sent, so a
// proof reads the ordinals, tools and parts the model made, and each answer
// is the shape the broker's settled turn returns (`broker-turn.ts`): words and
// tool calls under a call id, or the stop it recorded. Nothing here reaches a
// network or a database.

import {
  attemptState,
  type AttemptPorts,
  type AttemptState,
  type Turn,
  type TurnAnswer,
} from '../../packages/core-agent/src/index.ts';
import type { EndCode } from '../../packages/core-wire/src/index.ts';

export const TASK = '00000000-0000-4000-8000-0000000000a1';

/** The model asking to read its own task. */
export const reads = (n: number, text = 'Reading the task.'): TurnAnswer => ({
  callId: `answer_${String(n)}`,
  text,
  toolCalls: [{ id: `call_${String(n)}`, name: 'task.read', args: { taskId: TASK } }],
});

export const final = (n: number, text = 'Done.'): TurnAnswer => ({
  callId: `answer_${String(n)}`,
  text,
  toolCalls: [],
});

export interface Scripted {
  readonly state: AttemptState;
  readonly ports: AttemptPorts;
  readonly sent: Turn[];
  readonly ended: EndCode[];
  readonly toolRuns: () => number;
}

/** A port answering turn n (from 1) as `answer(n)` says. */
export function scripted(answer: (n: number) => TurnAnswer, revision = 3): Scripted {
  const state = attemptState(TASK, revision, ['task.read']);
  const sent: Turn[] = [];
  const ended: EndCode[] = [];
  let toolRuns = 0;
  const ports: AttemptPorts = {
    broker: {
      turn: async (turn) => {
        sent.push(turn);
        return await Promise.resolve(answer(sent.length));
      },
    },
    tools: new Map([
      [
        'task.read',
        async () => {
          toolRuns += 1;
          return await Promise.resolve({ revision, content: 'read' });
        },
      ],
    ]),
    end: async (code) => {
      ended.push(code);
      await Promise.resolve();
    },
  };
  return { state, ports, sent, ended, toolRuns: () => toolRuns };
}

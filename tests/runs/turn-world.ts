// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #1623 R3 turn proofs share, on the door world (`run-stop-door-world.ts`):
// the broker with the replay turn operation and a call limit, and the turn's
// parts as a worker sends them. A turn names what the broker reads (the run's
// task at a revision, an earlier answer by its call) and carries an answer's
// bytes back for the broker to check against the digest it kept.

import { randomUUID } from 'node:crypto';
import type { ModelBroker } from '../../packages/core-commands/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  REPLAY_TURN,
} from '../../packages/core-connectors/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { CLOUD, LOCAL } from '../broker/broker-world.ts';
import { revisionOf, type Schedules, type Work } from '../runtime/schedules-harness.ts';
import { asAgent, leaseOf, s, signedIn, world, type SignedIn } from './run-stop-door-world.ts';

export const TURN: string = REPLAY_TURN.key;

/** The door's broker for turns: a cloud route first, a local one for what may not leave. */
export const turnBroker = (callLimit: number) => (): ModelBroker =>
  ({
    custody: world.custody,
    operations: catalogue([REPLAY_COMPOSE, REPLAY_TURN]),
    providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
    routes: [CLOUD, LOCAL],
    installation: 'here',
    callLimit,
  }) as ModelBroker;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The model asking to read the run's own task. */
export const readCall = (work: Work, id = 'call_1'): ToolCall => ({
  id,
  name: 'task.read',
  args: { taskId: work.taskId },
});

/** The replay provider's answer: words, and the tools the model asks for. */
export const replied = (text: string, toolCalls: readonly ToolCall[] = []): unknown => ({
  text,
  model: 'replay-1',
  usage: { input: 40, output: 30 },
  tool_calls: toolCalls,
});

/** The run's task at its current revision, or as a tool call's result. */
export async function taskPart(
  work: Work,
  extra: Readonly<Record<string, unknown>> = {},
  of: Schedules = s,
): Promise<Record<string, unknown>> {
  return {
    ref: 'task',
    taskId: work.taskId,
    revision: await revisionOf(of, work.taskId),
    ...extra,
  };
}

/** An earlier answer, carried back with the bytes the broker returned. */
export const answerPart = (
  answer: Readonly<Record<string, unknown>>,
  altered: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  ref: 'answer',
  callId: answer['callId'],
  text: answer['text'],
  toolCalls: answer['toolCalls'],
  ...altered,
});

/** A `model.call` turn on the work's lease. */
export const turnBody = (
  work: Work,
  turnOrdinal: number,
  parts: readonly unknown[],
  tools: readonly string[] = ['task.read'],
): Record<string, unknown> => ({
  operationId: randomUUID(),
  leaseId: leaseOf(work),
  fence: work.picked['fence'],
  operation: TURN,
  kind: 'turn',
  turnOrdinal,
  tools,
  parts,
});

export const detailOf = (answer: Answer): Readonly<Record<string, unknown>> =>
  (answer.body['detail'] ?? {}) as Readonly<Record<string, unknown>>;

/** Turn 0: the task alone, answered with words and a read of the task. Its answer's detail. */
export async function firstTurn(
  work: Work,
  as: SignedIn,
  at?: { readonly of: Schedules; readonly key: string },
): Promise<Readonly<Record<string, unknown>>> {
  world.provider.script([replied('Reading the task.', [readCall(work)])]);
  const answer = await asAgent(
    '/model/call',
    work,
    turnBody(work, 0, [await taskPart(work, {}, at?.of)]),
    as,
    at?.key,
  );
  const detail = detailOf(answer);
  if (detail['state'] !== 'settled') {
    throw new Error(`setup: turn 0 did not settle: ${JSON.stringify(answer.body)}`);
  }
  return detail;
}

export { signedIn };

// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, the agent on the real stack, end to end: the worker's agent
// runner (`apps/worker/agent-runner.ts`) is `core-agent`'s LangChain loop,
// and on an accepted plan nobody has launched it reads its task, takes its
// turns through the real HTTP agent door and broker on the replay turn
// operation, and ends in exactly one outcome.
//
// - A task read, then a final answer: one `success / COMPLETED` row and one
//   review handback, with nothing applied before a Launch. The model's tool
//   call round-trips: the second turn carries the first answer back byte for
//   byte, and the tool's result as the task under that call.
// - Answers that only ever ask for tools, at limit 3 (TEST F2's exact limit,
//   through the real graph and worker): the third settlement writes
//   `call_limit`, there is no fourth `model.call`, no handback and no
//   `run.end`, and the run never reads as a draft.

import { expect, it as vitestIt } from 'vitest';
import {
  catalogue,
  REPLAY_COMPOSE,
  REPLAY_TURN,
} from '../../packages/core-connectors/src/index.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { acceptedPlan, decisionsOn, verbsOf, type Seam } from './compute-seam-world.ts';
import {
  brokerOver,
  named,
  noDatabase,
  outcomesOf,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('r4agentrun');

const LIMIT = 3;

/** The door's broker with the replay turn operation and the attempt's call limit. */
const turnBroker = () => ({
  ...brokerOver(),
  operations: catalogue([REPLAY_COMPOSE, REPLAY_TURN]),
  callLimit: LIMIT,
});

const readCall = (taskId: string, n: number) => ({
  id: `call_${String(n)}`,
  name: 'task.read',
  args: { taskId },
});

const replied = (text: string, toolCalls: readonly unknown[] = []): unknown => ({
  text,
  model: 'replay-1',
  usage: { input: 40, output: 30 },
  tool_calls: toolCalls,
});

async function agentPlan(title: string): Promise<Seam> {
  const runner = agentRunner({ operation: REPLAY_TURN.key, limit: LIMIT });
  return await acceptedPlan(title, runner as never, turnBroker() as never);
}

const turnsOf = (seam: Seam) => seam.log.filter((sent) => sent.verb === 'model.call');

it('a task read then a final answer hands back once for review with one success row', async () => {
  const seam = await agentPlan('agent reads, then answers');
  world.provider.script([
    replied('Reading the task.', [readCall(seam.taskId, 1)]),
    replied('Done.'),
  ]);
  await seam.worker.applyOnce(seam.taskId);

  expect(shapeOf(await outcomesOf(seam.work()))).toEqual([named('success', 'COMPLETED')]);
  const verbs = verbsOf(seam);
  expect(verbs.filter((verb) => verb === 'task.handback')).toHaveLength(1);
  expect(verbs).not.toContain('run.end');
  expect(verbs).not.toContain('task.comment');
  expect(await decisionsOn(seam.taskId), 'nobody launched').toBe(1);

  const turns = turnsOf(seam);
  expect(turns.map((turn) => turn.detail['state'])).toEqual(['settled', 'settled']);
  const [first, second] = turns;
  const parts = second?.body['parts'] as readonly Record<string, unknown>[];
  expect(parts[1], 'the first answer carried back as the broker returned it').toEqual({
    ref: 'answer',
    callId: first?.detail['callId'],
    text: first?.detail['text'],
    toolCalls: first?.detail['toolCalls'],
  });
  expect(parts[2]).toMatchObject({ ref: 'task', taskId: seam.taskId, toolCallId: 'call_1' });
});

it('answers that only ask for tools end call_limit at the third settlement, never as a draft', async () => {
  const seam = await agentPlan('agent loops on its tools');
  world.provider.script(
    [1, 2, 3, 4].map((n) => replied('Reading again.', [readCall(seam.taskId, n)])),
  );
  await seam.worker.applyOnce(seam.taskId);

  expect(shapeOf(await outcomesOf(seam.work()))).toEqual([
    named('call_limit', 'CALL_LIMIT_REACHED'),
  ]);
  expect(turnsOf(seam), 'no fourth model.call').toHaveLength(LIMIT);
  const verbs = verbsOf(seam);
  expect(verbs, 'no review handback').not.toContain('task.handback');
  expect(verbs, 'the server wrote it').not.toContain('run.end');
});

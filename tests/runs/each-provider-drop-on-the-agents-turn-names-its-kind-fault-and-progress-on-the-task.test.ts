// SPDX-License-Identifier: AGPL-3.0-only
//
// #1738, criterion 2 (U103's AW-10 checklist on the new runner): the shipped
// worker computes the owner's accepted plan with `agentRunner` on the replay
// provider, and its turn meets each of AW-10's three drops: the provider down
// (its 503), the connection cut with no answer, and the worker lost mid-turn
// (custody took the call, never answered, and the lease ran out). Each is read
// on the task as its people read it (`readCallDrops`): which drop, whose fault
// and where the work got to, with the hold kept whole, the attempt stopped
// unknown and a person told. The runner's own stop after the broker recorded
// the drop changes none of it, and no two drops read the same.

import { expect, it as vitestIt } from 'vitest';
import {
  attemptsOf,
  callsOf,
  droppedTurn,
  dropsOf,
  lostTurn,
  pass,
  toldOf,
} from './agent-drop-world.ts';
import { verbsOf } from './compute-seam-world.ts';
import { noDatabase, useStopWorld } from './run-stop-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('u103drop');

const SENT = [
  { mode: 'unavailable', cause: 'provider_unavailable', fault: 'provider', code: 'http_503' },
  { mode: 'cut', cause: 'connection_lost', fault: 'network', code: null },
] as const;

/** One drop on the task: its kind, fault, provider code and where the work got to. */
async function onTheTask(taskId: string, cause: string, fault: string, code: string | null) {
  const [drop, ...more] = await dropsOf(taskId);
  expect(more, cause).toEqual([]);
  expect(drop, cause).toMatchObject({
    operation: 'model.agent_turn',
    cause,
    fault,
    providerCode: code,
    reconcileMode: 'provider_lookup',
    reached: 'started',
    afterEvent: expect.any(Number),
    unknownSince: expect.any(String),
    stepId: expect.any(String),
  });
  expect(await callsOf(taskId), cause).toMatchObject([
    { state: 'liability_unknown', drop_cause: cause, fault, reserved: '500', actual: null },
  ]);
  expect(await attemptsOf(taskId), cause).toMatchObject([
    {
      state: 'liability_unknown',
      drop_cause: cause,
      held: 'held',
      run_outcome: 'unknown_provider_outcome',
      end_code: 'LIABILITY_UNKNOWN',
    },
  ]);
  expect(await toldOf(taskId), cause).toMatchObject([{ cause, reactivated: false, progress: 1 }]);
  return { cause: drop?.cause, fault: drop?.fault };
}

it("each provider drop on the agent's turn names its kind, fault and progress on the task, and no two collapse", async () => {
  const seen: { cause: unknown; fault: unknown }[] = [];
  for (const one of SENT) {
    // eslint-disable-next-line no-await-in-loop -- one drop at a time on one provider
    const { seam, outcome } = await droppedTurn(one.mode, `u103 ${one.mode}`);
    expect(outcome, one.mode).toMatchObject({ ended: { taskId: seam.taskId } });
    // The turn went out once, and nothing was handed back or applied after it.
    const verbs = verbsOf(seam);
    expect(
      verbs.filter((verb) => verb === 'model.call'),
      one.mode,
    ).toHaveLength(1);
    expect(verbs, one.mode).not.toContain('task.handback');
    expect(verbs, one.mode).not.toContain('task.comment');
    // eslint-disable-next-line no-await-in-loop -- read after the pass above
    seen.push(await onTheTask(seam.taskId, one.cause, one.fault, one.code));
  }

  const lost = await lostTurn('u103 lost');
  await pass();
  const [drop] = await dropsOf(lost.taskId);
  expect(drop).toMatchObject({
    operation: 'model.agent_turn',
    cause: 'worker_lost',
    fault: 'ours',
    providerCode: null,
    reached: 'started',
    afterEvent: expect.any(Number),
    stepId: expect.any(String),
  });
  expect(await attemptsOf(lost.taskId)).toMatchObject([
    { state: 'liability_unknown', drop_cause: 'worker_lost', held: 'held' },
  ]);
  expect(await toldOf(lost.taskId)).toMatchObject([{ cause: 'worker_lost', reactivated: false }]);
  seen.push({ cause: drop?.cause, fault: drop?.fault });

  // Collapsing any pair would make two of these the same.
  expect(new Set(seen.map((one) => one.cause)).size).toBe(3);
  expect(new Set(seen.map((one) => one.fault)).size).toBe(3);
}, 180_000);

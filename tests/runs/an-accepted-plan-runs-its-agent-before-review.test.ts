// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, an accepted plan runs its agent before review. The worker's plan
// is accepted and nobody has launched it. Its pass meets `LAUNCH_NOT_DECIDED`
// at dispatch, and there, under the plan's own lease, the worker runs the
// injected runner's `compute` (phase `compute`). A success goes to the review
// handback: one handback, one `success / COMPLETED` row, and no effect,
// comment or observe before a Launch. Any other end stops there: no review
// handback, no comment, no observe, and the attempt's outcome is the one its
// owning stop wrote (the runner's own `run.end` for a tool refusal, the
// person's cancel for a cancel).
//
// Control: a runner that computes nothing (`computes-nothing-runner.ts`) ends
// in success. The plan goes back for review, the person launches it, and the
// next pass applies its one comment and observes it.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { approve } from '../runtime/schedules-harness.ts';
import { COMPUTES_NOTHING } from '../support/computes-nothing-runner.ts';
import {
  asWorker,
  cancelTask,
  door,
  modelCall,
  named,
  noDatabase,
  outcomesOf,
  runEnd,
  s,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';
import {
  acceptedPlan,
  decisionsOn,
  marksOf,
  scripted,
  verbsOf,
  type Seam,
  type StepEnd,
} from './compute-seam-world.ts';
import type { OutcomeRow } from './run-outcomes-read.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('r2computeseam');

const SUCCESS: StepEnd = { outcome: 'success', endCode: 'COMPLETED' };

/** What only a Launch may lead to: the effect and its observation. */
const AFTER_LAUNCH = ['task.comment', 'task.observe'];

/** The plan's pass with `script` as the runner's compute. */
async function computed(
  title: string,
  script: Parameters<typeof scripted>[1],
): Promise<{ seam: Seam; ran: ReturnType<typeof scripted> }> {
  let seam: Seam | undefined;
  const ran = scripted(() => {
    if (seam === undefined) throw new Error('the runner ran before its worker existed');
    return seam;
  }, script);
  seam = await acceptedPlan(title, ran.runner);
  await seam.worker.applyOnce(seam.taskId);
  return { seam, ran };
}

/** The runner computed once, at dispatch, under the plan's live lease and before any Launch. */
function expectComputedBeforeLaunch(seam: Seam, ran: ReturnType<typeof scripted>): void {
  expect(ran.computed, 'the injected runner computed once').toHaveLength(1);
  expect(ran.computed[0], 'compute ran under the accepted plan, not launched').toEqual({
    phase: 'compute',
    leaseLive: true,
    planLease: true,
    decisions: 1,
  });
  const verbs = verbsOf(seam);
  expect(verbs[verbs.indexOf('compute') - 1], 'compute follows the refused dispatch').toBe(
    'task.dispatch',
  );
  const dispatch = seam.log.find((sent) => sent.verb === 'task.dispatch');
  expect(dispatch?.status, 'dispatch refused the plan its launch').not.toBe(200);
}

/** No effect, comment, observe or provider start, and the attempt carries no mark. */
async function expectNothingApplied(seam: Seam): Promise<void> {
  for (const verb of AFTER_LAUNCH) {
    expect(verbsOf(seam), `no ${verb} before a Launch`).not.toContain(verb);
  }
  const started = seam.log.filter(
    (sent) => sent.verb === 'task.heartbeat' && sent.body['providerStarting'] === true,
  );
  expect(started, 'no provider start').toEqual([]);
  expect(await marksOf(seam.work()), 'the step carries no mark').toEqual({
    marked: false,
    observed: false,
  });
  expect(await decisionsOn(seam.taskId), 'nobody launched').toBe(1);
}

it('a scripted success reads the task, takes a turn, then hands back once for review with one success row', async () => {
  world.provider.mode('answer');
  const turns: unknown[] = [];
  const { seam, ran } = await computed('plan computes, then review', async (work) => {
    const read = await asWorker(door(), work, 'task/read', {
      operationId: randomUUID(),
      recordId: work.taskId,
    });
    turns.push(read.status);
    const turn = await modelCall(work);
    turns.push((turn.body['detail'] as { state?: unknown } | undefined)?.state);
    return SUCCESS;
  });

  expectComputedBeforeLaunch(seam, ran);
  expect(turns, 'the runner read its task and its turn settled').toEqual([200, 'settled']);
  const verbs = verbsOf(seam);
  expect(
    verbs.filter((verb) => verb === 'task.handback'),
    'one review handback',
  ).toHaveLength(1);
  expect(verbs.indexOf('task.handback'), 'the handback follows the compute').toBeGreaterThan(
    verbs.indexOf('compute'),
  );
  expect(
    shapeOf(await outcomesOf(seam.work())),
    'the review handback writes the one success',
  ).toEqual([named('success', 'COMPLETED')]);
  await expectNothingApplied(seam);
});

const ENDS: readonly {
  readonly what: string;
  readonly stop: Parameters<typeof scripted>[1];
}[] = [
  {
    what: 'a tool refusal the runner ends through its own run.end',
    stop: async (work) => {
      await runEnd(work, 'TOOL_REFUSED');
      return { outcome: 'cancelled', endCode: 'TOOL_REFUSED' };
    },
  },
  {
    what: "a person's cancel while the runner computes",
    stop: async (work) => {
      await cancelTask(work);
      return { outcome: 'cancelled', endCode: 'TASK_CANCELLED' };
    },
  },
];

for (const end of ENDS) {
  it(`${end.what} never reaches review, comment or observe, and keeps the stop's own outcome`, async () => {
    world.provider.mode('answer');
    let written: readonly OutcomeRow[] = [];
    const { seam, ran } = await computed(end.what, async (work) => {
      const answered = await end.stop(work);
      written = await outcomesOf(work);
      return answered;
    });

    expectComputedBeforeLaunch(seam, ran);
    expect(verbsOf(seam), 'no review handback').not.toContain('task.handback');
    await expectNothingApplied(seam);
    expect(written, 'the owning stop wrote one outcome').toHaveLength(1);
    expect(
      await outcomesOf(seam.work()),
      'the outcome is the one the stop wrote, unchanged',
    ).toEqual(written);
  });
}

it('control: a runner that computes nothing hands back, and once launched applies its one comment', async () => {
  const seam = await acceptedPlan('computes nothing', COMPUTES_NOTHING);
  const first = await seam.worker.applyOnce(seam.taskId);
  if (!('handedBack' in first)) throw new Error(`hand back: ${JSON.stringify(first)}`);
  expect(verbsOf(seam), 'nothing applied before the Launch').not.toContain('task.comment');

  await approve(s, { ...first.handedBack });
  const applied = await seam.worker.applyOnce(seam.taskId);
  expect(applied, 'the launch applies').toMatchObject({ applied: { taskId: seam.taskId } });
  const after = verbsOf(seam).slice(verbsOf(seam).lastIndexOf('task.pickup'));
  expect(
    after.filter((verb) => AFTER_LAUNCH.includes(verb)),
    'one comment, observed',
  ).toEqual(AFTER_LAUNCH);
});

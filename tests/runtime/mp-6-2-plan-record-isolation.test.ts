// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's stored plan record (20261003001115), its security line against a real
// database: a record of another business or of another client's task is
// never stored on a step, a step written without one never takes one later,
// a step's stored record is never changed or cleared, no step is written
// without saying which record it saw, and a row forged past the trigger reads
// nothing of the other task. Each crossing is a real one, beside a positive
// control that stores the record on its own task.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  createTask,
  freshPurpose,
  propose,
  proposeBody,
  rows,
} from './schedules-harness.ts';
import { acceptPlanOn, noDatabase, proposeStep, readAs, useAw06World, w } from './aw-06-world.ts';
import { cq8World } from './cq-8-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('mp62storediso');

/** The step row of `runId`, as the admin connection reads it. */
async function stepOf(runId: unknown) {
  const [step] = await rows<{ readonly id: string; readonly plan_record_id: string | null }>(
    w.s,
    `select id, plan_record_id from public.planned_steps where run_id = $1 and ordinal = 1`,
    [runId],
  );
  if (step === undefined) throw new Error(`no step for run ${String(runId)}`);
  return step;
}

/** A second step on `runId` naming `planRecordId`, written by `business`'s own role. */
async function storeOn(business: string, runId: unknown, planRecordId: string): Promise<void> {
  await w.s.db.app.withBusiness(business as never, async (tx) => {
    await tx.query(
      `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload,
         plan_record_id, plan_record_written)
       values ($1, $2, $3, 2, 'compose', '{}'::jsonb, $4, true)`,
      [business, randomUUID(), runId, planRecordId],
    );
  });
}

const STORED = /planned_steps_plan_record_fkey|planned_steps: the plan record/u;
const ROLLED_BACK = 'positive control, rolled back';

/** Two tasks of this business, each shared with a client of its own: one planned, one not. */
async function twoClients() {
  const own = await createTask(w.s, `mp62-stored-own-${randomUUID()}`);
  const plan = await acceptPlanOn(own);
  const crossedTask = await createTask(w.s, `mp62-stored-crossed-${randomUUID()}`);
  const crossed = await propose(w.s, crossedTask, { maximumMinor: 300, purpose: freshPurpose() });
  await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, w.s.decider, 'share'),
  );
  const world = cq8World(w.s);
  await world.client(w.s.business, w.s.decider, 'mp62stored-c1', own);
  await world.client(w.s.business, w.s.decider, 'mp62stored-c2', crossedTask);
  return { own, plan, crossedTask, crossedRun: crossed['runId'] };
}

/** A run of another business's own task, proposed by its member. */
async function foreignRun(): Promise<{ readonly business: string; readonly runId: unknown }> {
  const world = cq8World(w.s);
  const other = await world.party('mp62stored-other');
  const otherTask = other.tasks[0]!.id;
  const proposed = await world.command(
    other.id,
    other.member,
    proposeBody(otherTask, await world.revisionOfIn(other.id, otherTask), {
      maximumMinor: 300,
      purpose: freshPurpose(),
    }),
  );
  return { business: other.id, runId: appliedDetail(proposed as never, 'propose')['runId'] };
}

/** `stepId`'s record set past the trigger, as no role of the product can. */
async function forge(stepId: string, planRecordId: string): Promise<void> {
  await w.s.db.admin.transaction(async (execute) => {
    await execute(
      'alter table public.planned_steps disable trigger planned_steps_plan_record_on_task',
    );
    await execute(
      `update public.planned_steps set plan_record_id = $1, plan_record_written = true
        where id = $2`,
      [planRecordId, stepId],
    );
    await execute(
      'alter table public.planned_steps enable trigger planned_steps_plan_record_on_task',
    );
  });
}

it('MP-6-2 stored plan record isolation: a record of another business or another client is never stored on a step, a step written without one never takes one, and a forged one reads nothing', async () => {
  const { own, plan, crossedTask, crossedRun } = await twoClients();
  expect((await stepOf(crossedRun)).plan_record_id).toBeNull();

  // Positive control: the record is stored on a step of its own task.
  const control = w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload,
         plan_record_id, plan_record_written)
       values ($1, $2, $3, 2, 'compose', '{}'::jsonb, $4, true)`,
      [w.s.business, randomUUID(), plan.runId, plan.planRecordId],
    );
    throw new Error(ROLLED_BACK);
  });
  await expect(control).rejects.toThrow(ROLLED_BACK);

  // 1. Client to client: the crossed task's run names the other task's record.
  await expect(storeOn(w.s.business, crossedRun, plan.planRecordId)).rejects.toThrow(STORED);
  // 2. Another business: its own run names this business's record.
  const foreign = await foreignRun();
  await expect(storeOn(foreign.business, foreign.runId, plan.planRecordId)).rejects.toThrow(STORED);
  // 3. A step written without a record never takes one later.
  const moved = w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `update public.planned_steps set plan_record_id = $1, plan_record_written = true
        where run_id = $2`,
      [plan.planRecordId, crossedRun],
    );
  });
  await expect(moved).rejects.toThrow(/written once, at proposal/u);
  const stored = await rows<{ readonly n: string }>(
    w.s,
    `select count(*)::text as n from public.planned_steps where plan_record_id = $1`,
    [plan.planRecordId],
  );
  expect(stored).toEqual([{ n: '0' }]);

  // 4. Forged anyway: the crossed task's read names nothing of the other task's.
  await forge((await stepOf(crossedRun)).id, plan.planRecordId);
  const body = JSON.stringify(await readAs(w.s.decider, crossedTask));
  for (const needle of [plan.planRecordId, plan.runId, own]) expect(body).not.toContain(needle);
});

/** `stepId`'s two stored columns, as the admin connection reads them. */
async function recordOf(stepId: string) {
  return await rows<{
    readonly plan_record_id: string | null;
    readonly plan_record_written: boolean;
  }>(w.s, `select plan_record_id, plan_record_written from public.planned_steps where id = $1`, [
    stepId,
  ]);
}

it('MP-6-2 stored plan record isolation: a stored record never moves, to another record of the same task or to none', async () => {
  const taskId = await createTask(w.s, `mp62-stored-moves-${randomUUID()}`);
  const first = await acceptPlanOn(taskId);
  const proposal = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
    'propose under draft',
  );
  const second = await acceptPlanOn(taskId);
  const step = await stepOf(proposal['runId']);
  const held = [{ plan_record_id: first.planRecordId, plan_record_written: true }];
  expect(await recordOf(step.id)).toEqual(held);

  /** `set` on the step as the application role: refused, the row unmoved. */
  const refused = async (set: string, values: readonly unknown[] = []): Promise<void> => {
    const moved = w.s.db.app.withBusiness(w.s.business, async (tx) => {
      await tx.query(`update public.planned_steps set ${set} where id = $1`, [step.id, ...values]);
    });
    await expect(moved, set).rejects.toThrow(/written once, at proposal/u);
    expect(await recordOf(step.id)).toEqual(held);
  };
  await refused('plan_record_written = false, plan_record_id = null');
  await refused('plan_record_id = $2', [second.planRecordId]);
  await refused('plan_record_id = null');
});

it('MP-6-2 stored plan record isolation: a step written without saying which record it saw is refused', async () => {
  const taskId = await createTask(w.s, `mp62-stored-unsaid-${randomUUID()}`);
  const { runId } = await propose(w.s, taskId, { maximumMinor: 300, purpose: freshPurpose() });
  const unsaid = w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
       values ($1, $2, $3, 2, 'compose', '{}'::jsonb)`,
      [w.s.business, randomUUID(), runId],
    );
  });
  await expect(unsaid).rejects.toMatchObject({
    code: '23514',
    message: expect.stringMatching(/planned_steps: a step is written with the plan record/u),
  });
  const steps = await rows<{ readonly n: string }>(
    w.s,
    `select count(*)::text as n from public.planned_steps where run_id = $1`,
    [runId],
  );
  expect(steps).toEqual([{ n: '1' }]);
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The T2e suites' world: one business with a planner who holds no budget
// permission, two billing holders, a member without one, a task-scoped holder,
// and two external clients each sharing one planned task and holding a billing
// grant there that R4 must never let them use (Sol, #130). Split from the
// suite so no file passes the per-file cap.

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { cq8World } from './cq-8-world.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asPerson,
  createTask,
  freshPurpose,
  openSchedules,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

/** The plan's estimated maximum, which opens the envelope at this figure. */
export const MAXIMUM = 2_500;
/** Under the shipped band of 500 (50 000 minor units). */
export const SMALL = 10_000;
/** Above it. */
export const LARGE = 60_000;

export const topUpBody = (
  taskId: string,
  amountMinor: number,
  fromMaximumMinor: number,
): Readonly<Record<string, unknown>> => ({
  command: 'budget.top_up',
  operationId: randomUUID(),
  recordId: taskId,
  amountMinor,
  fromMaximumMinor,
});

export interface TopUpWorld {
  readonly s: Schedules;
  readonly second: Member;
  readonly planner: Member;
  readonly nobody: Member;
  readonly taskScoped: Member;
  readonly clientA: Member;
  readonly clientB: Member;
  /** The tasks shared with `clientA` and `clientB`, whose plans the planner approved. */
  readonly clientTask: string;
  readonly clientTaskB: string;
  as(who: Member, body: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  topUp(who: Member, taskId: string, amountMinor: number, from: number): Promise<CommandResult>;
  maximumOf(taskId: string, business?: string): Promise<number>;
  /** A task with an approved plan, so an envelope to top up, approved by `by`. */
  planned(by?: Member): Promise<{ taskId: string; decision: Detail }>;
  setBand(value: string): Promise<void>;
}

export async function openTopUpWorld(part: string): Promise<TopUpWorld> {
  const s = await openSchedules(part, 1_000_000);
  const as = async (who: Member, body: Readonly<Record<string, unknown>>) =>
    await executeCommand(s.db.app, s.business, who.presented, 'api', body as never);
  const planned = async (by: Member = s.decider) => {
    const taskId = await createTask(s, `t2e ${randomUUID()}`);
    const proposal = appliedDetail(
      await asPerson(
        s,
        proposeBody(taskId, await revisionOf(s, taskId), {
          purpose: freshPurpose(),
          maximumMinor: MAXIMUM,
        }),
      ),
      'task.propose',
    );
    const decision = appliedDetail(await as(by, approveBody(proposal)), 'task.decide');
    return { taskId, decision };
  };
  const second = await enrol(s.db.app, s.business, 'second');
  const planner = await enrol(s.db.app, s.business, 'planner');
  const nobody = await enrol(s.db.app, s.business, 'nobody');
  const taskScoped = await enrol(s.db.app, s.business, 'task-scoped-billing');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await installBusinessSettings(tx);
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, second, 'decide', undefined, false, 'billing');
    await grantTo(tx, s.decider, 'share');
    // The planner decides plans and holds no budget permission.
    for (const action of ['read', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, planner, action);
    }
  });
  const clientTask = (await planned(planner)).taskId;
  const clientTaskB = (await planned(planner)).taskId;
  const clientA = await cq8World(s).client(s.business, s.decider, 'client-a', clientTask);
  const clientB = await cq8World(s).client(s.business, s.decider, 'client-b', clientTaskB);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, clientA, 'decide', { kind: 'record', id: clientTask }, false, 'billing');
    await grantTo(tx, clientB, 'decide', { kind: 'record', id: clientTaskB }, false, 'billing');
  });
  return {
    s,
    second,
    planner,
    nobody,
    taskScoped,
    clientA,
    clientB,
    clientTask,
    clientTaskB,
    as,
    topUp: async (who, taskId, amountMinor, from) =>
      await as(who, topUpBody(taskId, amountMinor, from)),
    maximumOf: async (taskId, business = s.business) =>
      Number(
        (
          await rows<{ readonly maximum: string }>(
            s,
            `select maximum_minor::text as maximum from public.task_envelopes
              where business_id = $1 and task_id = $2 and state = 'open'`,
            [business, taskId],
          )
        )[0]?.maximum,
      ),
    planned,
    setBand: async (value) => {
      await s.db.admin.execute(
        `update public.business_settings set value = $2::text::jsonb
          where business_id = $1 and key = 'four_eyes_threshold'`,
        [s.business, value],
      );
    },
  };
}

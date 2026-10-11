// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-16 follow-up, as the assignment now stands: a person's
// budget.record_outcome can end an agent's work. recordOutcome
// (packages/core-runtime/src/recovery/outcome.ts) revokes the stuck attempt's
// delegation when it resumes the step (`resume` in reconcile.ts) and a
// replacement's when `happened` stops it (`stopReplacement`). Neither takes the
// task from the agent: the task names the agent, not a delegation, and no
// `task.assign` is audited for it (Assign to AI).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asPerson,
  openSchedules,
  pickup,
  revisionOf,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();
if (url === undefined)
  console.warn('review-2c1-16 outcome: DATABASE_URL is unset, so nothing ran.');

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('rb16out', 1_000_000);
  await openBilling(s);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The decider, who owns the agent, assigns it the task it works. */
const assignAgent = async (taskId: string): Promise<void> => {
  await s.db.admin.execute(`update public.actors set owner_person_id = $2 where id = $1`, [
    s.agentActorId,
    s.decider.personId,
  ]);
  appliedDetail(
    await asPerson(s, {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { agent: s.agentActorId },
    }),
    'task.assign',
  );
};

/** The task's agent and its applied task.assign rows. */
const clearOf = async (taskId: string) => {
  const [task] = await rows<{ readonly agent: string | null }>(
    s,
    `select data ->> 'agent' as agent from public.records where id = $1`,
    [taskId],
  );
  const events = await rows<{ readonly actor: string }>(
    s,
    `select actor_id::text as actor from public.audit_events
      where subject_record_id = $1 and command = 'task.assign' and outcome = 'applied'`,
    [taskId],
  );
  return { agent: task?.agent ?? null, count: events.length };
};

/** The outcome left the agent holding the task, with no assignment audited. */
const keptBy = (
  before: Awaited<ReturnType<typeof clearOf>>,
  after: Awaited<ReturnType<typeof clearOf>>,
): void => {
  expect(after).toStrictEqual({ agent: s.agentActorId, count: before.count });
};

describe.skipIf(url === undefined)(
  'REVIEW-2C1-16 the agent keeps its task, on a recorded outcome',
  { timeout: 60_000 },
  () => {
    it('REVIEW-2C1-16: a person’s nothing_happened resumes the step and leaves the agent the task', async () => {
      const w = await h.t2d.work();
      await assignAgent(w.taskId);
      await h.t2d.dispatched(w);
      await h.t3b.expire(w);
      await h.t3b.sweep();
      const before = await clearOf(w.taskId);
      expect(before.agent).toBe(s.agentActorId);
      const recorded = appliedDetail(
        await h.outcome(w, 'nothing_happened'),
        'budget.record_outcome',
      );
      expect(String(recorded['resumed'])).toMatch(/^resumed as attempt/u);
      keptBy(before, await clearOf(w.taskId));
    });

    it('REVIEW-2C1-16: a person’s happened stops the replacement and leaves the agent the task', async () => {
      const original = await h.unknownStep({ applied: false, room: true });
      await h.reconcile();
      await pickup(s, await h.replacement(original));
      await assignAgent(original.taskId);
      const before = await clearOf(original.taskId);
      expect(before.agent).toBe(s.agentActorId);
      appliedDetail(await h.outcome(original, 'happened'), 'budget.record_outcome');
      keptBy(before, await clearOf(original.taskId));
    });
  },
);

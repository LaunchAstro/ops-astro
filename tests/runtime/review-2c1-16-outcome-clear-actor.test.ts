// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-16 follow-up: a person's budget.record_outcome can end an agent's
// work, and the audit row that clears that agent from its task names the
// agent as the actor. recordOutcome (packages/core-runtime/src/recovery/
// outcome.ts) revokes the stuck attempt's delegation when it resumes the step
// (`resume` in reconcile.ts) and a replacement's when `happened` stops it
// (`stopReplacement`), and neither passes the person who recorded the outcome
// to revokeDelegation, which then falls back to the agent's own actor. Passes
// once the recorded outcome carries its person into the clear.

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
  type Detail,
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

/** The decider assigns the agent working the task, by its delegation. */
const assignAgent = async (taskId: string, picked: Detail): Promise<void> => {
  appliedDetail(
    await asPerson(s, {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { agent: String(picked['delegationId']) },
    }),
    'task.assign',
  );
};

/** The task's agent, its applied task.assign rows and the newest one's actor. */
const clearOf = async (taskId: string) => {
  const [task] = await rows<{ readonly agent: string | null }>(
    s,
    `select data ->> 'agent' as agent from public.records where id = $1`,
    [taskId],
  );
  const events = await rows<{ readonly actor: string }>(
    s,
    `select actor_id::text as actor from public.audit_events
      where subject_record_id = $1 and command = 'task.assign' and outcome = 'applied'
      order by seq desc`,
    [taskId],
  );
  return { agent: task?.agent ?? null, count: events.length, actor: events[0]?.actor };
};

/** The outcome cleared the agent in one more row, audited as the decider. */
const clearedByThePerson = (
  before: Awaited<ReturnType<typeof clearOf>>,
  after: Awaited<ReturnType<typeof clearOf>>,
): void => {
  expect(after.agent).toBeNull();
  expect(after.count).toBe(before.count + 1);
  expect(
    after.actor,
    'the agent was named as the actor of the task.assign clear that the person’s budget.record_outcome caused',
  ).not.toBe(s.agentActorId);
  expect(after.actor).toBe(s.decider.actorId);
};

describe.skipIf(url === undefined)(
  'REVIEW-2C1-16 who clears the agent, on a recorded outcome',
  { timeout: 60_000 },
  () => {
    it('REVIEW-2C1-16: a person’s nothing_happened resumes the step, clears the agent, and the clear is audited as that person, not the agent', async () => {
      const w = await h.t2d.work();
      await assignAgent(w.taskId, w.picked);
      await h.t2d.dispatched(w);
      await h.t3b.expire(w);
      await h.t3b.sweep();
      const before = await clearOf(w.taskId);
      expect(before.agent).toBe(String(w.picked['delegationId']));
      const recorded = appliedDetail(
        await h.outcome(w, 'nothing_happened'),
        'budget.record_outcome',
      );
      expect(String(recorded['resumed'])).toMatch(/^resumed as attempt/u);
      clearedByThePerson(before, await clearOf(w.taskId));
    });

    it('REVIEW-2C1-16: a person’s happened stops the replacement, clears its agent, and the clear is audited as that person, not the agent', async () => {
      const original = await h.unknownStep({ applied: false, room: true });
      await h.reconcile();
      const picked = await pickup(s, await h.replacement(original));
      await assignAgent(original.taskId, picked);
      const before = await clearOf(original.taskId);
      expect(before.agent).toBe(String(picked['delegationId']));
      appliedDetail(await h.outcome(original, 'happened'), 'budget.record_outcome');
      clearedByThePerson(before, await clearOf(original.taskId));
    });
  },
);

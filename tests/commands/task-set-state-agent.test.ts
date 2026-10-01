// SPDX-License-Identifier: AGPL-3.0-only
//
// Stage 1 adds: task.set_state under a live delegation, kept beside
// task-set-state.test.ts. The status is a person's call: an agent holding a
// live delegation sets no task's state, its own or another's, and the refusal
// carries nothing of the task it named. The world is the ad hoc agent cases'.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf } from './agent-fixture.ts';
import { CANARY, revision, serverUrl, setUp, tearDown, world } from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-set-state: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const stateOf = async (recordId: string): Promise<string | null | undefined> =>
  (
    await world.db.admin.execute<{ readonly state: string | null }>(
      `select data ->> 'state' as state from public.records where id = $1`,
      [recordId],
    )
  )[0]?.state;

const onHold = async (): Promise<string> =>
  (
    await world.db.admin.execute<{ readonly id: string }>(
      `select r.id from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and t.key = 'task_state' and r.txt_1 = 'on_hold'`,
      [world.business],
    )
  )[0]?.id ?? '';

describe.skipIf(serverUrl === undefined)(
  'Stage 1 adds: task.set_state isolation under a live delegation',
  () => {
    it('an agent sets the state of neither its own delegated task nor another', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const stateId = await onHold();
      expect(stateId).not.toBe('');
      const refusedTo = async (taskId: string): Promise<void> => {
        const before = await stateOf(taskId);
        const answer = await world.asAgent(
          {
            command: 'task.set_state',
            operationId: randomUUID(),
            recordId: taskId,
            expectedRevision: await revision(taskId),
            stateId,
          },
          picked.credential,
        );
        expect(codeOf(answer)).not.toBe('not-a-refusal');
        expect(JSON.stringify(answer)).not.toContain(CANARY);
        expect(JSON.stringify(answer)).not.toContain(taskId);
        expect(await stateOf(taskId)).toBe(before);
      };
      await refusedTo(picked.taskId);
      await refusedTo(otherId);
      // The person who delegated sets it on the person entry.
      const own = await world.asPerson(decider, {
        command: 'task.set_state',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await revision(picked.taskId),
        stateId,
      });
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(await stateOf(picked.taskId)).toBe(stateId);
    });
  },
);

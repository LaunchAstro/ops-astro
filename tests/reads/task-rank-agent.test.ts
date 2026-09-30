// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9 isolation: an agent under a live delegation: cases kept beside task-
// rank.test.ts, each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { detailOf, codeOf } from '../commands/agent-fixture.ts';
import { CANARY, serverUrl, setUp, tearDown, world } from './rank-agent-world.ts';

if (serverUrl === undefined) {
  console.warn('task-rank: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** A record's revision, read on the administrative connection. */
const revision = async (recordId: string): Promise<number> =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

describe.skipIf(serverUrl === undefined)(
  'MP-4-9 isolation: an agent under a live delegation',
  () => {
    it('ranks its one delegated task #1 and names no other task', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      await world.asPerson(decider, {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: otherId,
        expectedRevision: await revision(otherId),
        fields: { impact: 10, confidence: 10, ease: 10 },
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      await world.asPerson(decider, {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await revision(picked.taskId),
        fields: { impact: 2, confidence: 2, ease: 2 },
      });
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { rank: { number: number | null; calc: string } };
      expect([task.rank.number, task.rank.calc]).toStrictEqual([
        1,
        'impact 2 × confidence 2 × ease 2 × priority 1 × age 1 = 8 · derived',
      ]);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const foreign = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: otherId },
        picked.credential,
      );
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
    });
  },
);

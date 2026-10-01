// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10 isolation: client access under a live delegation: cases kept beside
// task-client-access.test.ts, each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { REVOKE, SHARE, serverUrl, setUp, tearDown, world } from './client-access-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-client-access: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-10 isolation: client access under a live delegation',
  () => {
    it('an agent is refused both ways, even on its own task and under a sharer’s delegation', async () => {
      const decider = await world.decider('decider');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, decider, 'share', undefined, false, 'access');
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      const grantsBefore = await world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.grants where business_id = $1`,
        [world.business],
      );
      const agentToggle = async (command: string) => {
        const rows = await world.db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where id = $1`,
          [picked.taskId],
        );
        return await world.asAgent(
          {
            command,
            operationId: randomUUID(),
            recordId: picked.taskId,
            expectedRevision: Number(rows[0]?.revision),
          },
          picked.credential,
        );
      };
      expect(codeOf(await agentToggle(SHARE))).not.toBe('not-a-refusal');
      expect(codeOf(await agentToggle(REVOKE))).not.toBe('not-a-refusal');
      const grantsAfter = await world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.grants where business_id = $1`,
        [world.business],
      );
      expect(grantsAfter[0]?.n).toBe(grantsBefore[0]?.n);
    });
  },
);

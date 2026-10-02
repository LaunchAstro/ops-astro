// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10 isolation: ad hoc under a live delegation: cases kept beside task-
// adhoc.test.ts, each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf } from './agent-fixture.ts';
import {
  CANARY,
  markOf,
  revision,
  serverUrl,
  setUp,
  tearDown,
  world,
} from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn('task-adhoc: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-10 isolation: ad hoc under a live delegation',
  () => {
    it('an agent marks its own delegated task, and no other', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const own = await world.asAgent(
        {
          command: 'task.set_adhoc',
          operationId: randomUUID(),
          recordId: picked.taskId,
          expectedRevision: await revision(picked.taskId),
          fields: { ad_hoc: true },
        },
        picked.credential,
      );
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(await markOf(picked.taskId)).toBe(true);
      const foreign = await world.asAgent(
        {
          command: 'task.set_adhoc',
          operationId: randomUUID(),
          recordId: otherId,
          expectedRevision: await revision(otherId),
          fields: { ad_hoc: true },
        },
        picked.credential,
      );
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
      expect(await markOf(otherId)).toBeNull();
    });
  },
);

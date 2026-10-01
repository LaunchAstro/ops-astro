// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-14 isolation, the third crossing: another person's task under a live
// delegation. The agent reads its own task's state through task.read and
// never another person's finished task, nor anything of it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf, detailOf } from './agent-fixture.ts';
import { CANARY, revision, serverUrl, setUp, tearDown, world } from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-corrections-agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-14 isolation', () => {
  it('another person under a live delegation: the agent reads its own task, never another’s finished one', async () => {
    const decider = await world.decider('decider');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: CANARY },
    });
    const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
    await world.asPerson(decider, {
      command: 'task.complete',
      operationId: randomUUID(),
      recordId: otherId,
      expectedRevision: await revision(otherId),
    });
    const picked = await world.pickUp(decider, 'the agent’s task');
    const own = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    const task = detailOf(own)['task'] as { readonly title: string };
    expect(task.title).toBe('the agent’s task');
    const foreign = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: otherId },
      picked.credential,
    );
    expect(codeOf(foreign)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
  });
});

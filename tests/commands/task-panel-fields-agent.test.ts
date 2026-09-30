// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 isolation, the third crossing: another person's task under a live
// delegation. An agent picks up one task from its decider; the panel's edits
// sent with its credential reach that task and nothing of another task. The
// ticket's Permissions table gives an agent the name, the due date and the
// estimate "inside its delegation" (SL08-ANS-ORCH31: follow the roadmap), so
// on its own task they apply as a person's would.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf } from './agent-fixture.ts';
import { CANARY, revision, serverUrl, setUp, tearDown, world } from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-panel-fields-agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const titleOf = async (recordId: string): Promise<string | null | undefined> =>
  (
    await world.db.admin.execute<{ readonly title: string | null }>(
      `select txt_4 as title from public.records where id = $1`,
      [recordId],
    )
  )[0]?.title;

describe.skipIf(serverUrl === undefined)('MP-4-8 isolation', () => {
  it('another person under a live delegation: the agent’s edits reach its own task only', async () => {
    const decider = await world.decider('decider');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: CANARY },
    });
    const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
    const picked = await world.pickUp(decider, 'the agent’s task');
    const send = async (recordId: string, fields: Record<string, unknown>) =>
      await world.asAgent(
        {
          command: 'task.update',
          operationId: randomUUID(),
          recordId,
          expectedRevision: await revision(recordId),
          fields,
        },
        picked.credential,
      );
    expect(codeOf(await send(picked.taskId, { description: 'own text' }))).toBe('not-a-refusal');
    const foreign = [
      await send(otherId, { description: 'reached' }),
      await send(otherId, { title: 'reached' }),
      await send(otherId, { due: '2026-10-08' }),
      await send(otherId, { estimated_minutes: 30 }),
    ];
    for (const answer of foreign) expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect(await titleOf(otherId)).toBe(CANARY);
    // Its own task: the name and the due date apply inside its delegation.
    const rename = await send(picked.taskId, { title: 'renamed by the agent' });
    const due = await send(picked.taskId, { due: '2026-10-08' });
    const estimate = await send(picked.taskId, { estimated_minutes: 30 });
    expect([codeOf(rename), codeOf(due), codeOf(estimate)]).toStrictEqual([
      'not-a-refusal',
      'not-a-refusal',
      'not-a-refusal',
    ]);
    expect(await titleOf(picked.taskId)).toBe('renamed by the agent');
  });
});

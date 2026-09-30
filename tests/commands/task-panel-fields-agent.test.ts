// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 isolation, the third crossing: another person's task under a live
// delegation. An agent picks up one task from its decider; the panel's edits
// sent with its credential reach that task's texts and nothing of another
// task. On main an agent's `task.update` writes only the description and the
// brief (MP-4-7), so its rename is refused on its own task too, naming the
// field; the ticket's "yes, inside its delegation" for the name and the due
// date is an open question in the SL08 handback, not widened here.

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
    ];
    for (const answer of foreign) expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect(await titleOf(otherId)).toBe(CANARY);
    // Its own task's name stays the decider's: an agent renames nothing on main.
    const rename = await send(picked.taskId, { title: 'renamed by the agent' });
    expect(isCommandRefusal(rename) ? [rename.code, rename.names] : 'applied').toStrictEqual([
      'SCOPE_NOT_GRANTED',
      ['title'],
    ]);
    expect(await titleOf(picked.taskId)).toBe('the agent’s task');
  });
});

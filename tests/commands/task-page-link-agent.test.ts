// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-12 isolation, the third crossing: another person's task under a live
// delegation. The ticket's Permissions table gives an agent the page link
// "inside its delegation" (SL08-ANS-ORCH31: follow the roadmap): it links its
// own task, and another person's task gains nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf } from './agent-fixture.ts';
import { CANARY, revision, serverUrl, setUp, tearDown, world } from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-page-link-agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const linkOf = async (recordId: string): Promise<unknown> =>
  (
    await world.db.admin.execute<{ readonly link: unknown }>(
      `select data -> 'page_link' as link from public.records where id = $1`,
      [recordId],
    )
  )[0]?.link ?? null;

describe.skipIf(serverUrl === undefined)('MP-4-12 isolation', () => {
  it('another person under a live delegation: the agent links its own task and not another’s', async () => {
    const decider = await world.decider('decider');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: CANARY },
    });
    const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
    const picked = await world.pickUp(decider, 'the agent’s task');
    const link = async (recordId: string) =>
      await world.asAgent(
        {
          command: 'task.update',
          operationId: randomUUID(),
          recordId,
          expectedRevision: await revision(recordId),
          fields: { page_link: '/clients/acme' },
        },
        picked.credential,
      );
    const foreign = await link(otherId);
    expect(codeOf(foreign)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect(await linkOf(otherId)).toBeNull();
    const own = await link(picked.taskId);
    expect(codeOf(own)).toBe('not-a-refusal');
    expect(await linkOf(picked.taskId)).toBe('/clients/acme');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on the purge the positive fixture misses:
// that fixture's trash is inside the retention window, so it purges nothing.
// Here an aged task carries everything a purge must clear before it deletes
// the row (`tasks/trash.ts`): a link to its duplicate, a share grant, a
// conversation opened on it, a time entry and a tag. One purge runs, and every
// table it changed must be one `task.purge` declares.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { pathFaults } from './s0-5-effect-diff.ts';

let harness: Harness;

/** A command the admin runs, which must apply; its detail. */
async function applied(
  name: Parameters<Harness['asPerson']>[0],
  body: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const answer = await harness.asPerson(name, body);
  if (answer.code !== 'ok') throw new Error(`${name} refused ${answer.code}`);
  return (answer.body['detail'] ?? {}) as Record<string, unknown>;
}

/** The task's current revision, as the record holds it. */
async function revisionOf(recordId: string): Promise<number> {
  const read = await harness.asPerson('task.read', { recordId });
  return (read.body['task'] as { readonly revision: number }).revision;
}

/** A trashed task an hour past a window of no days, holding every row a purge clears. */
async function agedTaskWithEverything(): Promise<void> {
  const share = COMMAND_SURFACE.find((one) => one.name === 'task.share_with_client');
  if (share === undefined) throw new Error('task.share_with_client is not in the surface');
  const shared = await harness.positiveBody(share);
  if ('exception' in shared) throw new Error(shared.exception);
  await applied('task.share_with_client', shared.body);
  const taskId = String(shared.body['recordId']);
  await applied('task.duplicate', { recordId: taskId, client: null, title: 'a copy', stepNames: [] });
  await applied('conversation.start', {
    scope: { kind: 'task', id: taskId },
    body: 'About the task the purge takes.',
  });
  await applied('time.log', { taskId, duration: '1h 30m', note: 'time on the purged task' });
  const tag = await applied('tag.create', { name: `purged ${taskId.slice(0, 8)}` });
  await applied('task.add_tag', { recordId: taskId, tagId: tag['tagId'] });
  await applied('task.trash', { recordId: taskId, expectedRevision: await revisionOf(taskId) });
  await harness.world.db.admin.execute(
    `update public.records set deleted_at = now() - interval '1 hour'
      where business_id = $1 and id = $2`,
    [harness.world.alpha, taskId],
  );
}

describe.skipIf(serverUrl === undefined)('S0-5 effect metadata: an aged purge', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_purge');
    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      const written = await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      });
      if (written === undefined || 'refused' in written) throw new Error('window not written');
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('an aged purge declares its changes to links, grants, conversations, time and tags', async () => {
    const faults = await pathFaults(harness.world.db.admin, {
      name: 'task.purge',
      code: 'ok',
      drives: ['records', 'record_links', 'grants', 'conversations', 'time_entries', 'task_tags'],
      prepare: async () => {
        await agedTaskWithEverything();
        return async () => (await harness.asPerson('task.purge', {})).code;
      },
    });
    expect(faults).toStrictEqual([]);
  }, 120_000);
});

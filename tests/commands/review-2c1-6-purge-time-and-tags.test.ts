// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-6 (REVIEW-BATCH #305, batch 2c1): task.purge faults on a trashed
// task that has a time entry or a tag. 0078's time_entries_task_fkey and
// 0081's task_tags_task_fkey point at public.records with no ON DELETE, and
// purgeTrashedTasks (core-records/src/tasks/trash.ts) neither keeps such a
// task back (its `holding` query asks only the runtime tables) nor deletes
// the rows first. The delete from records meets the key and the whole purge
// rolls back, so one timed or tagged task in the trash stops every other aged
// task in the business being purged, every time. Once the purge either holds
// such a task back or takes its time entries and tags with it, the purge
// applies and the other aged task is gone.
//
// Each case has its own business, so the other's trash never stands in its
// way. Retention is set to zero days, so all of a business's trash is aged.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { grantTo, type Member } from './fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('review-2c1-6: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('rb2c1n6');
  for (const [business, member] of [
    [w.alpha, w.ada],
    [w.bravo, w.bravoOwner],
  ] as const) {
    /* eslint-disable no-await-in-loop -- two businesses, one after the other */
    await w.db.app.withBusiness(business, installBusinessSettings);
    await w.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, member, 'manage');
      await grantTo(tx, member, 'write', WHOLE, false, 'tag');
      const written = await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      });
      if (written === undefined || 'refused' in written) throw new Error('window not written');
    });
    /* eslint-enable no-await-in-loop */
  }
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

/** Setup: a step that must apply, or the test stops on it, not on the defect. */
async function must(business: BusinessId, member: Member, body: Record<string, unknown>) {
  const answer = await w.as(business, member, body);
  if (isCommandRefusal(answer))
    throw new Error(`setup ${String(body['command'])} refused ${answer.code}`);
  return answer;
}

/** A task in the trash, aged an hour past a zero-day window. */
async function trash(business: BusinessId, member: Member, taskId: string) {
  const [row] = await w.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from records where business_id = $1 and id = $2`,
    [business, taskId],
  );
  await must(business, member, {
    command: 'task.trash',
    recordId: taskId,
    expectedRevision: Number(row?.revision),
  });
  await w.db.admin.execute(
    `update records set deleted_at = now() - interval '1 hour' where business_id = $1 and id = $2`,
    [business, taskId],
  );
}

/** The purge's outcome, or the fault it threw, so a fault reads as a failed expectation. */
async function purge(business: BusinessId, member: Member) {
  try {
    const answer = await w.as(business, member, {
      command: 'task.purge',
      operationId: randomUUID(),
    });
    return isCommandRefusal(answer)
      ? { refused: answer.code, names: answer.names }
      : { applied: true, purged: answer.detail['purged'] };
  } catch (error) {
    return { fault: error instanceof Error ? error.message : String(error) };
  }
}

const present = async (business: BusinessId, id: string) =>
  (
    await w.db.admin.execute(`select 1 from records where business_id = $1 and id = $2`, [
      business,
      id,
    ])
  ).length > 0;

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-6: purge beside time entries and tags', () => {
  it('REVIEW-2C1-6: a trashed task with a time entry does not fault task.purge; the other aged task is purged', async () => {
    const timed = await w.fresh(w.alpha, w.ada, 'timed then trashed');
    const other = await w.fresh(w.alpha, w.ada, 'plain trash');
    await must(w.alpha, w.ada, { command: 'time.log', taskId: timed, duration: '15' });
    await trash(w.alpha, w.ada, timed);
    await trash(w.alpha, w.ada, other);

    const answer = await purge(w.alpha, w.ada);
    expect(answer).toMatchObject({ applied: true });
    expect(await present(w.alpha, other), 'the other aged task is purged').toBe(false);
  });

  it('REVIEW-2C1-6: a trashed task with a tag does not fault task.purge; the other aged task is purged', async () => {
    const tagged = await w.fresh(w.bravo, w.bravoOwner, 'tagged then trashed');
    const other = await w.fresh(w.bravo, w.bravoOwner, 'plain trash');
    const made = await must(w.bravo, w.bravoOwner, { command: 'tag.create', name: 'Purgeable' });
    const tagId = String((made.detail as { tagId?: unknown }).tagId);
    await must(w.bravo, w.bravoOwner, { command: 'task.add_tag', recordId: tagged, tagId });
    await trash(w.bravo, w.bravoOwner, tagged);
    await trash(w.bravo, w.bravoOwner, other);

    const answer = await purge(w.bravo, w.bravoOwner);
    expect(answer).toMatchObject({ applied: true });
    expect(await present(w.bravo, other), 'the other aged task is purged').toBe(false);
  });
});

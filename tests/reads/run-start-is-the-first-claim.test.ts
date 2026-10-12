// SPDX-License-Identifier: AGPL-3.0-only
//
// A run's start on the task read is its first claim, in the order claims took
// the task lock. A claim's time is its transaction's start, so a later reclaim
// from a transaction that began earlier carries an earlier time; it must not
// read as the run's start.

import { describe, expect, it } from 'vitest';
import { asPerson, launched, noDatabase, r, useReceiptWorld } from '../api/aw-08-receipt-world.ts';

useReceiptWorld('runstart');

interface VersionSeen {
  readonly runId: string | null;
  readonly startedAt: string | null;
}

/** The task's versions as the person reads them. */
const versionsOf = async (taskId: string): Promise<readonly VersionSeen[]> => {
  const read = await asPerson('task.read', { recordId: taskId });
  const task = read.body['task'] as { proposals: { versions: VersionSeen[] }[] };
  return task.proposals.flatMap((lineage) => lineage.versions);
};

describe.skipIf(noDatabase)('a run start on the task read', () => {
  it('a later claim from an earlier transaction does not replace the run first claim time', async () => {
    const { taskId } = await launched();
    const claimed = (await versionsOf(taskId)).find((one) => one.startedAt !== null);
    if (!claimed?.runId || claimed.startedAt === null) throw new Error('no claimed run');
    // A reclaim placed after the first claim, whose transaction began an hour before it.
    await r.fixture.db.admin.execute(
      `insert into public.run_events
         (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id,
          detail, created_at)
       select e.business_id, gen_random_uuid(), e.run_id, e.task_id,
              (select max(position) + 1 from public.run_events
                where business_id = e.business_id and task_id = e.task_id),
              'claimed', e.lease_id, e.attempt_id, e.actor_id, '{}'::jsonb,
              e.created_at - interval '1 hour'
         from public.run_events e
        where e.business_id = $1 and e.run_id = $2 and e.kind = 'claimed'`,
      [r.fixture.business, claimed.runId],
    );
    const again = (await versionsOf(taskId)).find((one) => one.runId === claimed.runId);
    expect(again?.startedAt).toBe(claimed.startedAt);
  });
});

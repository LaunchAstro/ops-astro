// SPDX-License-Identifier: AGPL-3.0-only
//
// The moved-task case for `decision-evidence-binding.test.ts`, kept here so the
// suite reads as its cases: each task put on a client of its own, and a decided
// lineage and its run moved by the owner onto another task.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { bearer, call, personPath, type World } from '../acceptance/world.ts';

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

/** Each task on a new client of alpha's, set the way `task.set_party` sets it. */
export async function onOwnClients(world: World, taskIds: readonly string[]): Promise<void> {
  for (const recordId of taskIds) {
    /* eslint-disable no-await-in-loop -- one task after the other, as a person sets them */
    const client = randomUUID();
    await addClient(world.db.app, world.alpha, client, world.ada as Member);
    const revisions = await world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [recordId],
    );
    const set = await asAda(world, '/task/set_party', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(revisions[0]?.revision),
      fields: { client },
    });
    /* eslint-enable no-await-in-loop */
    expect(set.code, 'task.set_party').toBe('ok');
  }
}

/** Noah's bearer, holding `task:read` on `taskId` alone. */
export async function readerOf(world: World, taskId: string): Promise<string> {
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, world.noah as Member, 'read', { kind: 'record', id: taskId });
  });
  return world.noah.token;
}

/**
 * The owner moves a lineage and its run onto `taskId` in one transaction, with
 * their triggers off. The two rows still agree with each other's task, so the
 * composite lineage and run key holds; the decision, version and evidence pack
 * are left as they were signed.
 */
export async function moveLineage(world: World, lineageId: string, taskId: string): Promise<void> {
  await world.db.admin.transaction(async (execute) => {
    await execute('alter table public.proposal_lineages disable trigger all');
    await execute('alter table public.planned_runs disable trigger all');
    await execute('update public.proposal_lineages set task_id = $2 where id = $1', [
      lineageId,
      taskId,
    ]);
    await execute('update public.planned_runs set task_id = $2 where lineage_id = $1', [
      lineageId,
      taskId,
    ]);
    await execute('alter table public.planned_runs enable trigger all');
    await execute('alter table public.proposal_lineages enable trigger all');
  });
}

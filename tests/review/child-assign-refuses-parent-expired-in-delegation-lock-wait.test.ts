// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413: `task.assign` that waits on the child delegation's lock checks the child's
// parent after the wait, so a parent that expires meanwhile holds no task.
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { child, noDatabase, parentWork, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { awaitParked, holdRows, revisionOf, waitPast } from '../runtime/schedules-harness.ts';

useChildWorld('sol816delegwait');
const it = noDatabase ? vitestIt.skip : vitestIt;

it('child assignment refuses a parent that expires while it waits for the child delegation lock', async () => {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  const taskId = parent.purposeScope.id;
  const revision = await revisionOf(w.s, taskId);
  const holder = await holdRows(w.s, 'delegations', [minted.delegation.id]);
  await w.s.db.admin.execute(
    `update public.delegations set expires_at = clock_timestamp() + interval '2 seconds'
      where business_id = $1 and id = $2`,
    [w.s.business, parent.id],
  );
  await w.s.db.admin.execute(
    `update public.leases l set expires_at = d.expires_at
       from public.delegations d
      where l.business_id = $1 and d.business_id = l.business_id
        and d.id = $2 and l.delegation_id = d.id`,
    [w.s.business, parent.id],
  );
  const assigning = executeCommand(w.s.db.app, w.s.business, w.s.decider.presented, 'api', {
    command: 'task.assign',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: revision,
    fields: { agent: minted.delegation.id },
  });
  try {
    await awaitParked(w.s, 'delegations', 1);
    const before = await w.s.db.admin.execute<{ readonly live: boolean }>(
      'select expires_at > clock_timestamp() as live from public.delegations where id = $1',
      [parent.id],
    );
    expect(before[0]?.live, 'the assignment was parked before its parent expired').toBe(true);
    await waitPast(w.s, 'select expires_at from public.delegations where id = $1', parent.id);
  } finally {
    await holder.release();
  }
  const result = await assigning;
  const stored = await w.s.db.admin.execute<{ readonly agent: string | null }>(
    `select data ->> 'agent' as agent from public.records where business_id = $1 and id = $2`,
    [w.s.business, taskId],
  );
  expect.soft(codeOf(result)).toBe('DELEGATION_NOT_LIVE');
  expect(stored[0]?.agent).not.toBe(minted.delegation.id);
});

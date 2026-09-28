// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentWorld, type IdentWorld } from '../acceptance/ident-audit-cases.ts';
import { serverUrl } from '../acceptance/world.ts';

describe.skipIf(serverUrl === undefined)('Sol CQ-6 review', () => {
  let world: IdentWorld;

  beforeAll(async () => {
    world = await createIdentWorld('sol_cq6');
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it('Sol proof, criterion 6: an undescribed body field is refused before command code runs', async () => {
    const task = await world.h.freshTask('an unchanged task');
    const answer = await world.person(world.h.world.ada, 'task.complete', {
      recordId: task.id,
      expectedRevision: task.revision,
      unlistedOperand: 'a caller-supplied value',
    });
    const rows = await world.h.world.db.admin.execute<{ readonly revision: string }>(
      `select revision from public.records where id = $1`,
      [task.id],
    );

    expect(Number(rows[0]?.revision)).toBe(task.revision);
    expect(answer.code).toBe('COMMAND_BODY_INVALID');
  });

  it('Sol proof, criterion 6: the agent prefix refuses an undescribed body field', async () => {
    const picked = await world.pickUp(world.h.world.agent, 'agent task with an extra field');
    const answer = await world.agent(
      world.h.world.agent,
      'task.comment',
      {
        recordId: picked.taskId,
        body: 'a comment the row should refuse',
        audience: 'internal',
        unlistedOperand: 'a caller-supplied value',
      },
      picked.credential,
    );

    expect(answer.code).toBe('COMMAND_BODY_INVALID');
  });
});

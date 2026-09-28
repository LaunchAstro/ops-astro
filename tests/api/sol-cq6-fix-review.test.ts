// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentWorld, type IdentWorld } from '../acceptance/ident-audit-cases.ts';
import { serverUrl } from '../acceptance/world.ts';

describe.skipIf(serverUrl === undefined)('Sol CQ-6 fix review', () => {
  let world: IdentWorld;

  beforeAll(async () => {
    world = await createIdentWorld('sol_cq6_fix');
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it('Sol proof, criterion 6: a person command refuses an unrelated identifier before changing its task', async () => {
    const task = await world.h.freshTask('task with an unrelated identifier');
    const answer = await world.person(world.h.world.ada, 'task.complete', {
      recordId: task.id,
      expectedRevision: task.revision,
      gateId: randomUUID(),
    });
    const rows = await world.h.world.db.admin.execute<{ readonly revision: string }>(
      `select revision from public.records where id = $1`,
      [task.id],
    );

    expect(Number(rows[0]?.revision)).toBe(task.revision);
    expect(answer.code).toBe('COMMAND_BODY_INVALID');
  });

  it('Sol proof, criterion 6: an agent command refuses an unrelated identifier', async () => {
    const picked = await world.pickUp(world.h.world.agent, 'agent task with an unrelated id');
    const answer = await world.agent(
      world.h.world.agent,
      'task.comment',
      {
        recordId: picked.taskId,
        body: 'comment with a stray identifier',
        audience: 'internal',
        gateId: randomUUID(),
      },
      picked.credential,
    );

    expect(answer.code).toBe('COMMAND_BODY_INVALID');
  });
});

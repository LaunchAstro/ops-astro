// SPDX-License-Identifier: AGPL-3.0-only
//
// #2345: a person deletes a task, and an owner can bring it back.
//
// `task.delete` is the bin (`task.trash`) behind two more checks: it is
// `task:decide`, a person's act, and it refuses a task whose subtree carries
// money, run or client history, which is closed instead. Nothing is
// removed: the rows stay, marked deleted, and `task.restore` returns them by
// the batch the delete answered with.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import { serverUrl, type Answer } from './world.ts';

// eslint-disable-next-line max-lines-per-function -- one fixture, and the cases that share it
describe.skipIf(serverUrl === undefined)('task.delete', () => {
  let harness: Harness;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [harness.world.alpha, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  /** A fresh task with one of the fixture's clients set on it. */
  const clientTask = async (title: string): Promise<{ readonly id: string }> => {
    const task = await harness.freshTask(title);
    const clients = await harness.world.db.admin.execute<{ readonly id: string }>(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, gen_random_uuid(), $3, $2) returning id::text as id`,
      [harness.world.alpha, harness.world.ada.actorId, `Delete client ${randomUUID()}`],
    );
    const set = await harness.asPerson('task.set_party', {
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { client: clients[0]?.id },
    });
    expect(set.code, 'the client link').toBe('ok');
    return task;
  };

  const remove = async (recordId: string, caller?: { readonly token: string }): Promise<Answer> =>
    await harness.asPerson(
      'task.delete',
      { recordId, expectedRevision: await revisionOf(recordId) },
      'alpha',
      caller,
    );

  const listed = async (recordId: string): Promise<{ board: boolean; search: boolean }> => {
    const board = await harness.asPerson('task.board', { board: null });
    const search = await harness.asPerson('task.search', { query: 'deletable' });
    return {
      board: JSON.stringify(board.body).includes(recordId),
      search: JSON.stringify(search.body).includes(recordId),
    };
  };

  const auditOf = async (recordId: string) =>
    await harness.world.db.admin.execute<{ readonly command: string; readonly outcome: string }>(
      `select command, outcome from public.audit_events
        where business_id = $1 and subject_record_id = $2 and command = 'task.delete'`,
      [harness.world.alpha, recordId],
    );

  beforeAll(async () => {
    harness = await createHarness('task_delete_2345');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('deletes a plain task, hides it from reads and lists, audits it, and restores it', async () => {
    const task = await harness.freshTask('a deletable plain task');
    expect(await listed(task.id)).toStrictEqual({ board: true, search: true });

    const deleted = await remove(task.id);
    console.log(`delete a plain task: ${deleted.status} ${deleted.code}`);
    expect(deleted.code).toBe('ok');
    const batchId = (deleted.body['detail'] as Record<string, unknown>)['batchId'];
    expect(typeof batchId).toBe('string');

    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('NOT_FOUND');
    expect(await listed(task.id)).toStrictEqual({ board: false, search: false });
    expect(await auditOf(task.id)).toStrictEqual([{ command: 'task.delete', outcome: 'applied' }]);

    const rows = await harness.world.db.admin.execute<{ readonly by: string | null }>(
      `select deleted_by_actor_id::text as by from public.records where business_id = $1 and id = $2`,
      [harness.world.alpha, task.id],
    );
    expect(rows).toStrictEqual([{ by: harness.world.ada.actorId }]);

    const restored = await harness.asPerson('task.restore', { batchId });
    expect(restored.code).toBe('ok');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
    expect(await listed(task.id)).toStrictEqual({ board: true, search: true });
  });

  it('refuses a task with money and run history, and leaves it readable', async () => {
    const { subject } = await harness.approvedReservation();
    const refused = await remove(subject.id);
    console.log(`delete a task with a reservation: ${refused.status} ${refused.code}`);
    expect(refused.code).toBe('TASK_NOT_DELETABLE');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('Cancel its run instead');
    expect((await harness.asPerson('task.read', { recordId: subject.id })).code).toBe('ok');
  });

  it('refuses a task linked to a client', async () => {
    const task = await clientTask('a deletable client task');
    const refused = await remove(task.id);
    expect(refused.code).toBe('TASK_NOT_DELETABLE');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });

  it('refuses a parent whose subtask has run history, and deletes neither', async () => {
    const parent = await harness.freshTask('a deletable parent');
    const { subject: child } = await harness.approvedReservation();
    const moved = await harness.asPerson('task.reparent', {
      recordId: child.id,
      expectedRevision: await revisionOf(child.id),
      parentId: parent.id,
    });
    expect(moved.code, 'the reparent').toBe('ok');

    expect((await remove(parent.id)).code).toBe('TASK_NOT_DELETABLE');
    const reads = await Promise.all(
      [parent.id, child.id].map(
        async (id) => await harness.asPerson('task.read', { recordId: id }),
      ),
    );
    expect(reads.map((read) => read.code)).toStrictEqual(['ok', 'ok']);
  });

  it('refuses a member who can write tasks but not decide on them', async () => {
    const task = await harness.freshTask('a deletable task a member tries');
    const refused = await remove(task.id, harness.world.mia);
    expect(refused.code).toBe('SCOPE_NOT_GRANTED');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });

  it('refuses an agent credential', async () => {
    const task = await harness.freshTask('a deletable task an agent tries');
    const refused = await harness.asAgent('task.delete', {
      recordId: task.id,
      expectedRevision: task.revision,
    });
    console.log(`delete as an agent: ${refused.status} ${refused.code}`);
    expect(refused.status).toBe(403);
    expect(refused.code).not.toBe('ok');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });
});

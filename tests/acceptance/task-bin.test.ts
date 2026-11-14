// SPDX-License-Identifier: AGPL-3.0-only
//
// #2346: an owner sees the deleted tasks and restores one.
//
// `task.bin` lists each delete once, at the task the person deleted (its
// subtasks went with it and come back with it), with the key, title, who
// deleted it, when, and the batch `task.restore` takes. It is a list for a
// person who can delete (`task:decide`), filtered by that grant inside the
// query. Each crossing plants a canary in a deleted task's title and asks from
// the other side: another business, another record in the same business (a
// decider on one task only), a member without decide, an outside party and an
// agent. No answer, refusals included, carries the canary or its id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import { enrolCaller } from './cast.ts';
import { grantTo } from '../commands/fixture.ts';
import { enrolExternal, serverUrl, type Answer, type Caller } from './world.ts';

interface BinRow {
  readonly batchId: string;
  readonly taskId: string;
  readonly key: string;
  readonly title: string;
  readonly deletedAt: string;
  readonly deletedBy: string;
}

const rowsOf = (answer: Answer): readonly BinRow[] =>
  (answer.body['bin'] as readonly BinRow[] | undefined) ?? [];

/** The grant fixture's member: a caller with a person and an actor. */
const member = (caller: Caller) => ({
  personId: String(caller.personId),
  actorId: String(caller.actorId),
  presented: caller.presented,
});

// eslint-disable-next-line max-lines-per-function -- one fixture, and the crossings that share it
describe.skipIf(serverUrl === undefined)('task.bin', () => {
  let harness: Harness;
  const canary = `CANARY-${randomUUID()}`;
  let parent = '';
  let child = '';
  let batch = '';
  let other = '';
  let scopedDecider: Caller;
  let bravoDecider: Caller;
  let outsider: Caller;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [harness.world.alpha, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  const remove = async (recordId: string): Promise<string> => {
    const answer = await harness.asPerson('task.delete', {
      recordId,
      expectedRevision: await revisionOf(recordId),
    });
    expect(answer.code, 'the delete').toBe('ok');
    return String((answer.body['detail'] as Record<string, unknown>)['batchId']);
  };

  const bin = async (caller?: Caller, businessKey = 'alpha'): Promise<Answer> =>
    await harness.asPerson('task.bin', {}, businessKey, caller);

  const leaksNothing = (answer: Answer, label: string): void => {
    const body = JSON.stringify(answer.body);
    for (const marker of [canary, parent, child, batch]) {
      expect(body.includes(marker), `${label} names ${marker}`).toBe(false);
    }
  };

  beforeAll(async () => {
    harness = await createHarness('task_bin_2346');
    const { world } = harness;
    const made = await harness.freshTask(`${canary} deleted parent`);
    parent = made.id;
    child = (await harness.freshTask(`${canary} deleted child`)).id;
    const moved = await harness.asPerson('task.reparent', {
      recordId: child,
      expectedRevision: await revisionOf(child),
      parentId: parent,
    });
    expect(moved.code, 'the reparent').toBe('ok');
    batch = await remove(parent);
    other = (await harness.freshTask('another deleted task')).id;
    await remove(other);

    scopedDecider = await enrolCaller(world.db, world.alpha, 'alpha', 'scoped', {
      membership: true,
      actions: [],
      collections: [],
    });
    outsider = await enrolExternal(world);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, member(scopedDecider), 'decide', { kind: 'record', id: other });
      await grantTo(tx, member(outsider), 'decide', { kind: 'record', id: parent });
      await grantTo(tx, member(outsider), 'read', { kind: 'record', id: parent });
    });
    bravoDecider = await enrolCaller(world.db, world.bravo, 'bravo', 'bravo-decider', {
      membership: true,
      actions: ['read', 'write', 'decide'],
      collections: ['task'],
    });
    const bravoTask = await harness.asPerson(
      'task.create',
      { fields: { title: 'a bravo task' } },
      'bravo',
      bravoDecider,
    );
    expect(bravoTask.code, 'the bravo task').toBe('ok');
    const bravoId = String(bravoTask.body['recordId']);
    const bravoDeleted = await harness.asPerson(
      'task.delete',
      { recordId: bravoId, expectedRevision: Number(bravoTask.body['revision']) },
      'bravo',
      bravoDecider,
    );
    expect(bravoDeleted.code, 'the bravo delete').toBe('ok');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('lists a delete once, at the deleted task, with who and when, its subtask under it', async () => {
    const answer = await bin();
    console.log(`task.bin as the owner: ${answer.status} ${answer.code}`);
    expect(answer.code).toBe('ok');
    const rows = rowsOf(answer);
    const mine = rows.filter((row) => row.taskId === parent);
    expect(mine).toHaveLength(1);
    const [row] = mine;
    const names = await harness.world.db.admin.execute<{
      readonly name: string;
      readonly key: string;
    }>(
      `select p.display_name as name, r.txt_1 as key
         from public.people p, public.records r
        where p.business_id = $1 and p.id = $2 and r.business_id = $1 and r.id = $3`,
      [harness.world.alpha, harness.world.ada.personId, parent],
    );
    expect(row).toMatchObject({
      batchId: batch,
      key: names[0]?.key,
      title: `${canary} deleted parent`,
      deletedBy: names[0]?.name,
    });
    expect(Number.isNaN(Date.parse(row?.deletedAt ?? ''))).toBe(false);
    expect(
      rows.some((each) => each.taskId === child),
      'the subtask has no row of its own',
    ).toBe(false);
    expect(rows.some((each) => each.taskId === other)).toBe(true);
  });

  it('restores from the row, and the task leaves the list and is back on the board', async () => {
    const restoredTask = (await harness.freshTask('a task restored from the list')).id;
    const restoredBatch = await remove(restoredTask);
    const before = rowsOf(await bin()).find((row) => row.taskId === restoredTask);
    expect(before?.batchId).toBe(restoredBatch);

    const restored = await harness.asPerson('task.restore', { batchId: before?.batchId });
    expect(restored.code).toBe('ok');
    expect(rowsOf(await bin()).some((row) => row.taskId === restoredTask)).toBe(false);
    const board = await harness.asPerson('task.board', { board: null });
    expect(JSON.stringify(board.body)).toContain(restoredTask);
  });

  it('refuses a member who can write tasks but not decide on them, naming nothing', async () => {
    const answer = await bin(harness.world.mia);
    console.log(`task.bin as a member without decide: ${answer.status} ${answer.code}`);
    expect(answer.code).toBe('SCOPE_NOT_GRANTED');
    leaksNothing(answer, 'the member refusal');
  });

  it('shows a decider on one task that task alone, never another record of the business', async () => {
    const answer = await bin(scopedDecider);
    expect(answer.code).toBe('ok');
    expect(rowsOf(answer).map((row) => row.taskId)).toStrictEqual([other]);
    leaksNothing(answer, 'the record-scoped list');
  });

  it('shows another business its own bin and never this one, and refuses this one to it', async () => {
    const theirs = await bin(bravoDecider, 'bravo');
    expect(theirs.code).toBe('ok');
    expect(rowsOf(theirs).map((row) => row.title)).toStrictEqual(['a bravo task']);
    leaksNothing(theirs, 'the bravo list');

    const across = await bin(bravoDecider, 'alpha');
    expect(across.code).not.toBe('ok');
    leaksNothing(across, 'bravo asking alpha');
  });

  it('answers an outside party holding decide on the deleted task as for nothing at all', async () => {
    const answer = await bin(outsider);
    console.log(`task.bin as an outside party: ${answer.status} ${answer.code}`);
    expect(answer.code).toBe('NOT_FOUND');
    leaksNothing(answer, 'the outsider');
  });

  it('refuses an agent credential', async () => {
    const answer = await harness.asAgent('task.bin', {});
    console.log(`task.bin as an agent: ${answer.status} ${answer.code}`);
    expect(answer.code).not.toBe('ok');
    expect(answer.status).toBeGreaterThanOrEqual(400);
    leaksNothing(answer, 'the agent');
  });
});

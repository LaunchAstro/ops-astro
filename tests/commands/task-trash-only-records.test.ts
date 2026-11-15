// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite on one database, its cases in order */
//
// `task.trash` with `onlyRecords`: a caller who names what it means to trash is
// refused, with nothing written, when the subtree the trash walks under its
// lock holds any live record it did not name (#2523, for #2505's demo removal). The check
// sits in the trash's own transaction, after the walk's row locks, so a
// subtask filed after the caller looked, or one the caller cannot read, is
// found there and never trashed unseen. Without `onlyRecords` the trash still
// takes the whole subtree.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('task.trash with onlyRecords', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  type Command = Parameters<typeof executeCommand>[4];
  const run = async (command: Command) =>
    await executeCommand(db.app, business, worker.presented, 'api', command);
  const create = async (title: string, parentId?: string) => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
      ...(parentId === undefined ? {} : { parentId }),
    } as Command);
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return { id: made.recordId ?? '', revision: made.revision ?? 0 };
  };
  const trash = async (task: { id: string; revision: number }, onlyRecords?: unknown) =>
    await run({
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      ...(onlyRecords === undefined ? {} : { onlyRecords }),
    } as Command);
  const live = async (ids: readonly string[]): Promise<number> => {
    const rows = await db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.records
        where business_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
      [business, ids],
    );
    return Number(rows[0]?.n);
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'trash-only-records');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    // Business-wide write and nothing to read with: the subtree is judged on
    // what the walk finds, never on what the caller could see.
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('a trash naming only the task refuses when a subtask sits under it, and trashes nothing', async () => {
    const parent = await create('Demo parent');
    const child = await create('Real client work', parent.id);
    const refused = await trash(parent, [parent.id]);
    expect(isCommandRefusal(refused) ? refused.code : 'applied').toBe('TRASH_SUBTREE_CHANGED');
    expect(JSON.stringify(refused), 'no id or count of what sits below').not.toContain(child.id);
    expect(await live([parent.id, child.id])).toBe(2);
  });

  it('a trash naming the task and every subtask under it trashes them all', async () => {
    const parent = await create('Demo parent named whole');
    const child = await create('Demo child named whole', parent.id);
    const trashed = await trash(parent, [parent.id, child.id]);
    if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
    expect(trashed.detail['trashed']).toBe(2);
    expect(await live([parent.id, child.id])).toBe(0);
  });

  it('a trash without onlyRecords still takes the whole subtree', async () => {
    const parent = await create('A parent trashed whole');
    const child = await create('Its child', parent.id);
    const trashed = await trash(parent);
    if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
    expect(await live([parent.id, child.id])).toBe(0);
  });

  it('an onlyRecords that is not a list of ids naming the task is refused, and nothing is trashed', async () => {
    const task = await create('A task trashed with a bad list');
    for (const bad of ['all', [], ['not-an-id'], [randomUUID()], [task.id, 7]]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await trash(task, bad);
      expect(isCommandRefusal(refused) ? refused.code : 'applied', JSON.stringify(bad)).toBe(
        'FIELD_VALUE_INVALID',
      );
    }
    expect(await live([task.id])).toBe(1);
  });
});

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
import { slotOf, TASK_SPINE } from '../../packages/core-records/src/index.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();
const PARENT = slotOf(TASK_SPINE, 'parent');

describe.skipIf(serverUrl === undefined)('task.trash with onlyRecords', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  type Command = Parameters<typeof executeCommand>[4];
  const run = async (command: Command, as: Member = worker, at: string = business) =>
    await executeCommand(db.app, at, as.presented, 'api', command);
  const create = async (title: string, parentId?: string, as: Member = worker, at = business) => {
    const made = await run(
      {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title },
        ...(parentId === undefined ? {} : { parentId }),
      } as Command,
      as,
      at,
    );
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return { id: made.recordId ?? '', revision: made.revision ?? 0 };
  };
  const trash = async (
    task: { id: string; revision: number },
    onlyRecords?: unknown,
    as: Member = worker,
  ) =>
    await run(
      {
        command: 'task.trash',
        operationId: randomUUID(),
        recordId: task.id,
        expectedRevision: task.revision,
        ...(onlyRecords === undefined ? {} : { onlyRecords }),
      } as Command,
      as,
    );
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
    for (const bad of [
      'all',
      null,
      {},
      [],
      [[task.id]],
      ['not-an-id'],
      [randomUUID()],
      [task.id, 7],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await trash(task, bad);
      expect(isCommandRefusal(refused) ? refused.code : 'applied', JSON.stringify(bad)).toBe(
        'FIELD_VALUE_INVALID',
      );
    }
    expect(await live([task.id])).toBe(1);
  });

  it("a list in upper case, or one naming another business's record, trashes only what is here and named", async () => {
    const other = await insertBusiness(db.app, 'trash-only-records-other');
    await installSpine(db.app, other);
    const stranger = await enrol(db.app, other, 'stranger');
    await db.app.withBusiness(other, async (tx) => {
      await grantTo(tx, stranger, 'write');
    });
    const theirs = await create('Their task', undefined, stranger, other);
    const task = await create('Ours, named in capitals');
    const trashed = await trash(task, [task.id.toUpperCase(), theirs.id]);
    if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
    expect(trashed.detail['trashed']).toBe(1);
    const rows = await db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.records where id = $1 and deleted_at is null`,
      [theirs.id],
    );
    expect(Number(rows[0]?.n), "the other business's task is untouched").toBe(1);
  });

  it('a caller who cannot reach a subtask is refused for scope first, as without a list', async () => {
    const narrow = await enrol(db.app, business, 'narrow');
    const parent = await create('Demo parent, narrow caller');
    const child = await create('Real work out of reach', parent.id);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, narrow, 'write', { kind: 'record', id: parent.id });
    });
    const refused = await trash(parent, [parent.id], narrow);
    expect(isCommandRefusal(refused) ? refused.code : 'applied').toBe('SCOPE_NOT_GRANTED');
    expect(await live([parent.id, child.id])).toBe(2);
  });

  it("a subtask filed while the trash waits on the task's row is found under the lock, and nothing is trashed", async () => {
    const parent = await create('Demo parent, raced');
    const loose = await create('Real work filed mid-wait');
    // The holder takes the root's row, then, while the trash waits on it,
    // files the loose task under the root and commits.
    const held = await hold(
      db,
      async (execute) => {
        await execute('select id from public.records where id = $1 for update', [parent.id]);
      },
      async (execute) => {
        const filed = await execute<{ readonly parent: string | null }>(
          `update public.records set data = data || jsonb_build_object('parent', $1::text)
            where id = $2 returning ${PARENT}::text as parent`,
          [parent.id, loose.id],
        );
        if (filed[0]?.parent !== parent.id) throw new Error('the loose task was not filed');
      },
    );
    const trashing = trash(parent, [parent.id]);
    try {
      await waiterOf(db, held);
    } finally {
      await held.letGo();
    }
    const answer = await trashing;
    expect(isCommandRefusal(answer) ? answer.code : 'applied').toBe('TRASH_SUBTREE_CHANGED');
    expect(await live([parent.id, loose.id])).toBe(2);
  }, 30_000);
});

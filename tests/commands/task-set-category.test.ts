// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 CS-4.16 (DP-23; BUILDABLE-NOW (b)4): the task's work label.
//
// `task.set_category` writes one of the nine catalogue ids (`TASK_CATEGORIES`)
// or null, which clears it, under `task:write` on the task, at the revision
// read, audited as `task.category changed` under the command's name. Any other
// value is refused naming `category` and writes nothing. `task.read` and the
// board's row carry the stored id. An agent reaches it only inside its
// delegation, and a category never touches agent scope (R76):
// task-set-category-agent. The world is the ad hoc one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { COMMAND_SURFACE, TASK_CATEGORIES } from '../../packages/core-wire/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from './fixture.ts';
import {
  CANARY,
  alpha,
  as,
  bravo,
  bravoWriter,
  clientAWriter,
  db,
  fresh,
  outcomeOf,
  reader,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-set-category: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Task = { recordId: string; revision: number };

const stored = async (recordId: string): Promise<{ category: unknown; revision: number }> => {
  const rows = await db.admin.execute<{ readonly category: unknown; readonly revision: string }>(
    `select data -> 'category' as category, revision::text as revision
       from public.records where id = $1`,
    [recordId],
  );
  return { category: rows[0]?.category ?? null, revision: Number(rows[0]?.revision) };
};

const current = async (task: Task): Promise<Task> => ({
  recordId: task.recordId,
  revision: (await stored(task.recordId)).revision,
});

const setCategory = async (
  business: BusinessId,
  by: Member,
  task: Task,
  category: unknown,
  operationId: string = randomUUID(),
) =>
  await as(business, by, {
    command: 'task.set_category',
    operationId,
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { category },
  });

/** The category `task.read` answers for the task, or the refusal's code. */
const readCategory = async (business: BusinessId, by: Member, recordId: string) => {
  const read = await executeRead(db.app, business, by.presented, { read: 'task.read', recordId });
  if (isCommandRefusal(read)) return read.code;
  return 'task' in read ? (read.task as unknown as { category?: unknown }).category : 'no task';
};

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  it('is declared as a task write an agent reaches only inside its delegation', () => {
    const declared = COMMAND_SURFACE.find((each) => String(each.name) === 'task.set_category');
    expect([
      declared?.kind,
      declared?.collection,
      declared?.action,
      declared?.authorisedOn,
      declared?.agent,
    ]).toStrictEqual(['write', 'task', 'write', 'record', 'delegated']);
  });

  it('sets each of the nine, and task.read and the board row carry the stored id', async () => {
    const task = await fresh(alpha, writer, 'labelled');
    for (const { id } of TASK_CATEGORIES.list()) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await setCategory(alpha, writer, await current(task), id);
      expect(outcomeOf(answer), id).toStrictEqual({ applied: true });
      // oxlint-disable-next-line no-await-in-loop
      expect((await stored(task.recordId)).category, id).toBe(id);
    }
    expect(await readCategory(alpha, writer, task.recordId)).toBe('website-edits');
    const board = await executeRead(db.app, alpha, writer.presented, {
      read: 'task.board',
      board: null,
    });
    const rows = isCommandRefusal(board) || !('tasks' in board) ? [] : board.tasks;
    const row = (rows as unknown as readonly { id: string; category?: unknown }[]).find(
      (one) => one.id === task.recordId,
    );
    expect(row?.category).toBe('website-edits');
  });

  it('clears with null: the field is gone and the read says null', async () => {
    const task = await fresh(alpha, writer, 'cleared');
    await setCategory(alpha, writer, task, 'seo');
    const answer = await setCategory(alpha, writer, await current(task), null);
    expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    expect((await stored(task.recordId)).category).toBeNull();
    expect(await readCategory(alpha, writer, task.recordId)).toBeNull();
  });

  it('a task never labelled reads null', async () => {
    const task = await fresh(alpha, writer, 'unlabelled');
    expect(await readCategory(alpha, writer, task.recordId)).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  it.each([
    ['a label, not its id', 'SEO'],
    ['an id in another case', 'Seo'],
    ['a word off the list', 'agent-scope'],
    ['a blank', ''],
    ['a number', 7],
    ['true', true],
    ['an object', { id: 'seo' }],
    ['a list', ['seo']],
  ])('refuses %s by name and writes nothing', async (_label, value) => {
    const task = await fresh(alpha, writer, 'hostile');
    await setCategory(alpha, writer, task, 'content');
    const before = await stored(task.recordId);
    const answer = await setCategory(alpha, writer, await current(task), value);
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['category'] });
    expect(await stored(task.recordId)).toStrictEqual(before);
  });

  it('refuses a field it does not own, or none, and writes nothing', async () => {
    const task = await fresh(alpha, writer, 'strays');
    const stray = await as(alpha, writer, {
      command: 'task.set_category',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { category: 'seo', stage: 'sales' },
    });
    expect(outcomeOf(stray)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['stage=task.set_stage'],
    });
    const none = await as(alpha, writer, {
      command: 'task.set_category',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: {},
    });
    expect(outcomeOf(none)).toMatchObject({ code: 'FIELD_UNKNOWN' });
    expect(await stored(task.recordId)).toStrictEqual({ category: null, revision: task.revision });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  it('owns the label: task.update is refused and names the owning command', async () => {
    const task = await fresh(alpha, writer, 'generic');
    const answer = await as(alpha, writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { category: 'seo' },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['category=task.set_category'],
    });
  });

  it('at the read revision: a stale one is refused VERSION_STALE and writes nothing', async () => {
    const task = await fresh(alpha, writer, 'stale');
    await setCategory(alpha, writer, task, 'branding');
    const late = await setCategory(alpha, writer, task, 'reporting');
    expect(outcomeOf(late)).toMatchObject({ code: 'VERSION_STALE' });
    expect((await stored(task.recordId)).category).toBe('branding');
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  describe('MP-4-8 audit readback: task.category changed', () => {
    it('writes the change and the refusal to the audit chain as task.set_category', async () => {
      const task = await fresh(alpha, writer, 'audited');
      const [applied, refusal] = [randomUUID(), randomUUID()];
      await setCategory(alpha, writer, task, 'paid-ads', applied);
      await setCategory(alpha, reader, await current(task), 'seo', refusal);
      const events = await db.admin.execute<{
        readonly actor_id: string;
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
      }>(
        `select actor_id, outcome, refusal_code, subject_record_id from public.audit_events
          where business_id = $1 and command = 'task.set_category'
            and operation_id = any($2::text[])
          order by seq`,
        [alpha, [applied, refusal]],
      );
      // `toEqual`: the driver's rows are not plain objects.
      expect(events).toEqual([
        {
          actor_id: writer.actorId,
          outcome: 'applied',
          refusal_code: null,
          subject_record_id: task.recordId,
        },
        {
          actor_id: reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          subject_record_id: null,
        },
      ]);
      // The change and its record committed together: the label is what the audit says.
      expect((await stored(task.recordId)).category).toBe('paid-ads');
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  describe('MP-4-8 refusal task:write', () => {
    it('refuses a reader without task:write, names nothing of the task and writes nothing', async () => {
      const task = await fresh(alpha, writer, CANARY);
      const answer = await setCategory(alpha, reader, task, 'seo');
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(answer)).not.toContain(task.recordId);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await stored(task.recordId)).toStrictEqual({
        category: null,
        revision: task.revision,
      });
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  describe('MP-4-8 isolation: task category', () => {
    it('another business: its task is not found, keeps its label and shows no canary', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      await setCategory(bravo, bravoWriter, foreign, 'videography');
      const before = await stored(foreign.recordId);
      const answer = await setCategory(alpha, writer, await current(foreign), 'seo');
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(JSON.stringify(answer)).not.toContain('videography');
      expect(await stored(foreign.recordId)).toStrictEqual(before);
      expect(await readCategory(alpha, writer, foreign.recordId)).toBe('NOT_FOUND');
    });

    it('another client in the same business: a writer on client A’s task cannot label client B’s', async () => {
      const taskA = await fresh(alpha, writer, 'client A');
      const taskB = await fresh(alpha, writer, CANARY);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
      });
      expect(outcomeOf(await setCategory(alpha, clientAWriter, taskA, 'admin'))).toStrictEqual({
        applied: true,
      });
      const refused = await setCategory(alpha, clientAWriter, taskB, 'admin');
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect(await stored(taskB.recordId)).toStrictEqual({
        category: null,
        revision: taskB.revision,
      });
    });
  });
});

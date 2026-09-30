// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8: the dock task panel's field edits, on the server. The panel renames
// a task and sets its due date through `task.update` (`task:write`) and sets
// its assignee through `task.assign` (`task:assign`), at the revision it read
// (tests/web/mp-4-8-panel-fields.test.tsx proves the panel sends exactly
// that). These cases prove what those two commands do for the panel: who is
// refused, what joins the audit chain and what does not, what every reader
// sees after a rename, and that no edit crosses a business or a client. The
// crossing under a live delegation is task-panel-fields-agent.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  alpha,
  auditCount,
  auditOf,
  bravo,
  bravoEditor,
  clientA,
  clientAEditor,
  clientB,
  db,
  edit,
  editor,
  fresh,
  outcomeOf,
  readAs,
  reader,
  rowOf,
  serverUrl,
  setUp,
  tearDown,
  writerNoAssign,
} from './panel-fields-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-panel-fields: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-8 panel field edits', () => {
  it('MP-4-8 refusal task:write: a reader renames nothing and sets no due date', async () => {
    const id = await fresh(alpha, editor, 'kept name');
    const before = await rowOf(id);
    const rename = await edit(alpha, reader, 'task.update', id, { title: CANARY });
    const due = await edit(alpha, reader, 'task.update', id, { due: '2026-10-08' });
    expect([outcomeOf(rename), outcomeOf(due)]).toStrictEqual([
      { code: 'SCOPE_NOT_GRANTED' },
      { code: 'SCOPE_NOT_GRANTED' },
    ]);
    expect(await rowOf(id)).toStrictEqual(before);
  });

  it('MP-4-8 refusal task:assign: a writer without assign moves no assignee', async () => {
    const id = await fresh(alpha, editor, 'assign me');
    const refused = await edit(alpha, writerNoAssign, 'task.assign', id, {
      assignee: writerNoAssign.personId,
    });
    expect(outcomeOf(refused)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect((await rowOf(id))?.assignee).toBeNull();
    // The same person's rename, which task:write covers, is applied.
    const renamed = await edit(alpha, writerNoAssign, 'task.update', id, { title: 'renamed' });
    expect(outcomeOf(renamed)).toStrictEqual({ applied: true });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 panel field edits', () => {
  it('MP-4-8 audit readback: the rename, the due date and the assignee each join the chain', async () => {
    const id = await fresh(alpha, editor, 'audited');
    const ops = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await edit(alpha, editor, 'task.update', id, { title: 'audited, renamed' }, ops[0]);
    await edit(alpha, editor, 'task.update', id, { due: '2026-10-08' }, ops[1]);
    await edit(alpha, editor, 'task.assign', id, { assignee: editor.personId }, ops[2]);
    await edit(alpha, reader, 'task.update', id, { title: CANARY }, ops[3]);
    const applied = { actor_id: editor.actorId, outcome: 'applied', refusal_code: null };
    expect(JSON.parse(JSON.stringify(await auditOf(ops)))).toStrictEqual([
      { command: 'task.update', ...applied, subject_record_id: id },
      { command: 'task.update', ...applied, subject_record_id: id },
      { command: 'task.assign', ...applied, subject_record_id: id },
      {
        command: 'task.update',
        actor_id: reader.actorId,
        outcome: 'refused',
        refusal_code: 'SCOPE_NOT_GRANTED',
        // A refusal names no subject, so it confirms nothing about the task.
        subject_record_id: null,
      },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 panel field edits', () => {
  // Main writes an access event for every read (docs/local/API.md, I13: "who
  // looked at this"), with no operation id, and a task's history leaves reads
  // out. So opening the panel records who looked and changes nothing: no event
  // with an operation id, no write's command, no history entry. The panel's own
  // navigation and view state send nothing at all (the web suite).
  it('MP-4-8 no audit on reads: opening the panel records only who looked, and no change', async () => {
    const id = await fresh(alpha, editor, 'read only');
    const history = async () => {
      const read = await readAs(alpha, editor, id);
      return isCommandRefusal(read) || !('task' in read) ? null : read.task.history;
    };
    const before = await history();
    const since = await auditCount();
    await readAs(alpha, editor, id);
    await executeRead(db.app, alpha, editor.presented, { read: 'person.list' });
    await executeRead(db.app, alpha, editor.presented, { read: 'task.board', board: null });
    const added = await db.admin.execute<{ readonly command: string; readonly op: string | null }>(
      `select command, operation_id as op from public.audit_events
        where business_id = $1 order by seq offset $2`,
      [alpha, since],
    );
    expect(added.map((row) => [row.command, row.op])).toStrictEqual([
      ['task.read', null],
      ['person.list', null],
      ['task.board', null],
    ]);
    expect(await history()).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 panel field edits', () => {
  it('MP-4-8 rename updates everywhere: the task, its board row and another reader see the new name', async () => {
    const id = await fresh(alpha, editor, 'old name');
    await edit(alpha, editor, 'task.update', id, { title: 'new name' });
    const own = await readAs(alpha, reader, id);
    expect(isCommandRefusal(own) || !('task' in own) ? null : own.task.title).toBe('new name');
    const board = await executeRead(db.app, alpha, reader.presented, {
      read: 'task.board',
      board: null,
    });
    const rows = isCommandRefusal(board) || !('tasks' in board) ? [] : board.tasks;
    expect(rows.filter((row) => row.id === id).map((row) => row.title)).toStrictEqual(['new name']);
  });

  it('MP-4-8 assignee reads back: a person, then nobody, as chosen', async () => {
    const id = await fresh(alpha, editor, 'whose');
    await edit(alpha, editor, 'task.assign', id, { assignee: writerNoAssign.personId });
    const first = await readAs(alpha, reader, id);
    expect(
      isCommandRefusal(first) || !('task' in first) ? null : first.task.assignee?.personId,
    ).toBe(writerNoAssign.personId);
    await edit(alpha, editor, 'task.assign', id, { assignee: null });
    const second = await readAs(alpha, reader, id);
    expect(
      isCommandRefusal(second) || !('task' in second) ? 'refused' : second.task.assignee,
    ).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 isolation', () => {
  it('another business: its task is not found, nothing of it is echoed, and nothing changes', async () => {
    const foreign = await fresh(bravo, bravoEditor, CANARY);
    const before = await rowOf(foreign);
    const answers = [
      await edit(alpha, editor, 'task.update', foreign, { title: 'reached' }),
      await edit(alpha, editor, 'task.update', foreign, { due: '2026-10-08' }),
      await edit(alpha, editor, 'task.assign', foreign, { assignee: editor.personId }),
    ];
    expect(answers.map((answer) => outcomeOf(answer))).toStrictEqual([
      { code: 'NOT_FOUND' },
      { code: 'NOT_FOUND' },
      { code: 'NOT_FOUND' },
    ]);
    expect(JSON.stringify(answers)).not.toContain(CANARY);
    expect(await rowOf(foreign)).toStrictEqual(before);
    // And alpha's person is no assignee there: bravo's own assign names only bravo's people.
    const crossPerson = await edit(bravo, bravoEditor, 'task.assign', foreign, {
      assignee: editor.personId,
    });
    expect(outcomeOf(crossPerson)).toStrictEqual({ code: 'NOT_FOUND' });
    expect((await rowOf(foreign))?.assignee).toBeNull();
  });

  it('another client in the same business: client A’s editor changes client A’s task and not client B’s', async () => {
    const taskA = await fresh(alpha, editor, 'client A work', clientA);
    const taskB = await fresh(alpha, editor, CANARY, clientB);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAEditor, 'read', { kind: 'record', id: taskA });
      await grantTo(tx, clientAEditor, 'write', { kind: 'record', id: taskA });
    });
    const own = await edit(alpha, clientAEditor, 'task.update', taskA, { due: '2026-10-08' });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    expect((await rowOf(taskA))?.due).toBe('2026-10-08');
    const before = await rowOf(taskB);
    const answers = [
      await edit(alpha, clientAEditor, 'task.update', taskB, { title: 'reached' }),
      await edit(alpha, clientAEditor, 'task.update', taskB, { due: '2026-10-08' }),
    ];
    expect(answers.map((answer) => outcomeOf(answer))).toStrictEqual([
      { code: 'SCOPE_NOT_GRANTED' },
      { code: 'SCOPE_NOT_GRANTED' },
    ]);
    expect(JSON.stringify(answers)).not.toContain(CANARY);
    expect(await rowOf(taskB)).toStrictEqual(before);
    const read = await readAs(alpha, clientAEditor, taskB);
    expect(outcomeOf(read)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });
});

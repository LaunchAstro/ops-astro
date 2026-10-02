// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's estimate (CS-4.14, DP-21): the time the burn bar and time logged
// measure against. `estimated_minutes`, a generic field of the task written
// through `task.update` under `task:write` (fixed-slots contract), whole
// minutes, read back as `estimateMinutes`. These cases prove who sets it, what
// it keeps, that it joins the audit chain, and that no estimate crosses a
// business or a client. The crossing under a live delegation is
// task-panel-fields-agent.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  alpha,
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
  serverUrl,
  setUp,
  tearDown,
} from './panel-fields-world.ts';

if (serverUrl === undefined) {
  console.warn('task-estimate: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp('he');
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const estimateOf = async (recordId: string): Promise<unknown> =>
  (
    await db.admin.execute<{ readonly minutes: unknown }>(
      `select data -> 'estimated_minutes' as minutes from public.records where id = $1`,
      [recordId],
    )
  )[0]?.minutes ?? null;

const readEstimate = async (recordId: string): Promise<unknown> => {
  const read = await readAs(alpha, editor, recordId);
  if (isCommandRefusal(read) || !('task' in read)) return 'refused';
  return (read.task as unknown as Readonly<Record<string, unknown>>)['estimateMinutes'];
};

describe.skipIf(serverUrl === undefined)('MP-4-8 estimate', () => {
  it('MP-4-8 estimate set: whole minutes, read back, and cleared to not set', async () => {
    const id = await fresh(alpha, editor, 'estimated');
    expect(await readEstimate(id)).toBeNull();
    expect(
      outcomeOf(await edit(alpha, editor, 'task.update', id, { estimated_minutes: 90 })),
    ).toStrictEqual({
      applied: true,
    });
    expect(await readEstimate(id)).toBe(90);
    expect(
      outcomeOf(await edit(alpha, editor, 'task.update', id, { estimated_minutes: null })),
    ).toStrictEqual({
      applied: true,
    });
    expect(await readEstimate(id)).toBeNull();
  });

  it('MP-4-8 estimate keeps only whole minutes: anything else is refused by name and nothing is written', async () => {
    const id = await fresh(alpha, editor, 'estimate values');
    await edit(alpha, editor, 'task.update', id, { estimated_minutes: 60 });
    const values = [-15, 1.5, '90', 1_000_001, {}, true];
    const answers: unknown[] = [];
    for (const value of values) {
      // eslint-disable-next-line no-await-in-loop -- each edit reads the revision the last left
      const answer = await edit(alpha, editor, 'task.update', id, { estimated_minutes: value });
      answers.push(isCommandRefusal(answer) ? [answer.code, answer.names] : 'applied');
    }
    // A number outside whole minutes is the estimate's rule; any other kind is
    // the value-type check's, which names the field with the type it wants.
    const outside = ['FIELD_VALUE_INVALID', ['estimated_minutes']];
    const mistyped = ['FIELD_VALUE_INVALID', ['estimated_minutes=numeric']];
    expect(answers).toStrictEqual([outside, outside, mistyped, outside, mistyped, mistyped]);
    expect(await estimateOf(id)).toBe(60);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 estimate', () => {
  it('MP-4-8 refusal task:write: a reader sets no estimate', async () => {
    const id = await fresh(alpha, editor, 'reader estimate');
    const answer = await edit(alpha, reader, 'task.update', id, { estimated_minutes: 30 });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(await estimateOf(id)).toBeNull();
  });

  it('MP-4-8 audit readback: the estimate joins the chain as task.update', async () => {
    const id = await fresh(alpha, editor, 'audited estimate');
    const ops = [randomUUID(), randomUUID()];
    await edit(alpha, editor, 'task.update', id, { estimated_minutes: 120 }, ops[0]);
    await edit(alpha, reader, 'task.update', id, { estimated_minutes: 5 }, ops[1]);
    expect(JSON.parse(JSON.stringify(await auditOf(ops)))).toStrictEqual([
      {
        command: 'task.update',
        actor_id: editor.actorId,
        outcome: 'applied',
        refusal_code: null,
        subject_record_id: id,
      },
      {
        command: 'task.update',
        actor_id: reader.actorId,
        outcome: 'refused',
        refusal_code: 'SCOPE_NOT_GRANTED',
        subject_record_id: null,
      },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 isolation', () => {
  it('estimate, another business: not found, nothing echoed, nothing written', async () => {
    const foreign = await fresh(bravo, bravoEditor, CANARY);
    const answer = await edit(alpha, editor, 'task.update', foreign, { estimated_minutes: 45 });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'NOT_FOUND' });
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await estimateOf(foreign)).toBeNull();
  });

  it('estimate, another client in the same business: client A’s editor sets A’s and not B’s', async () => {
    const taskA = await fresh(alpha, editor, 'client A estimate', clientA);
    const taskB = await fresh(alpha, editor, CANARY, clientB);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAEditor, 'read', { kind: 'record', id: taskA });
      await grantTo(tx, clientAEditor, 'write', { kind: 'record', id: taskA });
    });
    const own = await edit(alpha, clientAEditor, 'task.update', taskA, { estimated_minutes: 30 });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    expect(await estimateOf(taskA)).toBe(30);
    const other = await edit(alpha, clientAEditor, 'task.update', taskB, { estimated_minutes: 30 });
    expect(outcomeOf(other)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(other)).not.toContain(CANARY);
    expect(await estimateOf(taskB)).toBeNull();
  });
});

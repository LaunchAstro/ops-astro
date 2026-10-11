// SPDX-License-Identifier: AGPL-3.0-only
//
// A command that changes records besides the one it names leaves an applied
// event on each, naming what changed: a restore re-takes a subtask's board
// from its live parent, and a completion archives the parent's open steps.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { made, type Made } from './field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

type Body = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, the cases on it in order
describe.skipIf(!configured)('restore and step archiving leave evidence on each record', () => {
  let world: AgentWorld;
  let mia: Decider;

  beforeAll(async () => {
    world = await agentWorld('restore_steps', 'restore-steps');
    mia = await world.decider('Mia');
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  const send = async (body: Body) => {
    const answer = await world.asPerson(mia, { operationId: randomUUID(), ...body });
    if (isCommandRefusal(answer))
      throw new Error(`${String(body['command'])} refused ${answer.code}`);
    return answer;
  };
  const create = async (operands: Body = {}) =>
    made(await send({ command: 'task.create', fields: { title: 'evidence' }, ...operands }));
  const current = async (recordId: string): Promise<Made> => {
    const rows = await world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [recordId],
    );
    return { recordId, revision: Number(rows[0]?.revision) };
  };
  const on = async (recordId: string, command: string, operands: Body = {}) =>
    await send({
      command,
      recordId,
      expectedRevision: (await current(recordId)).revision,
      ...operands,
    });
  const dataOf = async (recordId: string) =>
    (
      await world.db.admin.execute<{ readonly data: Body }>(
        'select data from public.records where id = $1',
        [recordId],
      )
    )[0]?.data ?? {};
  /** The applied events naming this record, of one command, as command and keys. */
  const evidence = async (recordId: string, command: string) =>
    (
      await world.db.admin.execute<{ readonly command: string; readonly field_changes: unknown }>(
        `select command, field_changes from public.audit_events
          where subject_record_id = $1 and command = $2 and outcome = 'applied' order by seq`,
        [recordId, command],
      )
    ).map((row) => ({ command: row.command, field_changes: row.field_changes }));
  const historyOf = async (recordId: string): Promise<readonly HistoryEntry[]> => {
    const answer = await executeRead(world.db.app, world.business, mia.presented, {
      read: 'task.read',
      recordId,
    } as never);
    if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
    return answer.task.history;
  };

  it('a restored subtask that takes its moved parent’s board has a restore event naming the board', async () => {
    const [boardA, boardB] = [await create(), await create()];
    const parent = await create({ board: boardA.recordId });
    const step = await create({ parentId: parent.recordId });
    const below = await create({ parentId: step.recordId });
    const trashed = await on(step.recordId, 'task.trash');
    await on(parent.recordId, 'task.move', { board: boardB.recordId });
    await send({ command: 'task.restore', batchId: trashed.detail['batchId'] });

    for (const restored of [step, below]) {
      // eslint-disable-next-line no-await-in-loop -- one record at a time
      expect((await dataOf(restored.recordId))['board']).toBe(boardB.recordId);
      // eslint-disable-next-line no-await-in-loop
      expect(await evidence(restored.recordId, 'task.restore')).toStrictEqual([
        { command: 'task.restore', field_changes: { version: 1, keys: ['board'] } },
      ]);
      // eslint-disable-next-line no-await-in-loop
      expect((await historyOf(restored.recordId)).at(-1)).toMatchObject({
        operation: 'task.restore',
        changed: ['board'],
      });
    }
  });

  it('a restore that changes no field is still in the restored task’s history', async () => {
    const task = await create();
    const trashed = await on(task.recordId, 'task.trash');
    await send({ command: 'task.restore', batchId: trashed.detail['batchId'] });
    expect(await evidence(task.recordId, 'task.restore')).toStrictEqual([
      { command: 'task.restore', field_changes: { version: 1, keys: [] } },
    ]);
    expect((await historyOf(task.recordId)).map((entry) => entry.operation)).toStrictEqual([
      'task.create',
      'task.trash',
      'task.restore',
    ]);
  });

  it('completing a parent records the archive on each open step, and reopening its removal', async () => {
    const parent = await create({ stateKey: 'active' });
    const step = await create({ parentId: parent.recordId });
    const before = await current(step.recordId);
    const historyBefore = await historyOf(step.recordId);
    await on(parent.recordId, 'task.complete');

    expect(await dataOf(step.recordId)).toHaveProperty('archived_at');
    expect((await current(step.recordId)).revision).toBeGreaterThan(before.revision);
    const archived = { version: 1, keys: ['archived_at', 'archived_why'] };
    expect(await evidence(step.recordId, 'task.complete')).toStrictEqual([
      { command: 'task.complete', field_changes: archived },
    ]);

    await on(parent.recordId, 'task.reopen', { reason: 'not finished' });
    expect(await dataOf(step.recordId)).not.toHaveProperty('archived_at');
    expect(await evidence(step.recordId, 'task.reopen')).toStrictEqual([
      { command: 'task.reopen', field_changes: archived },
    ]);
    // The step was not itself completed or reopened: its history is unchanged.
    expect(await historyOf(step.recordId)).toStrictEqual(historyBefore);
  });

  it('the audit chain still verifies', async () => {
    expect(await world.db.app.withBusiness(world.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });
});

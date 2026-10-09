// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  iceWorld,
  iceCommand,
  newIceTask,
  icePage,
  iceBoard,
  handle,
  type IceWorld,
} from './task-ice-editor-world.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  readAuditEvents,
  type AuditEventRow,
} from '../../packages/core-commands/src/commands/audit.ts';
let world: IceWorld;
beforeAll(async () => {
  world = await iceWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

function expectReadAuditOnly(
  before: readonly AuditEventRow[],
  after: readonly AuditEventRow[],
  recordId: string,
  operationId: string,
): void {
  expect(after.slice(0, before.length)).toStrictEqual(before);
  expect(
    after.slice(before.length).map(({ command, operation_id, outcome, subject_record_id }) => ({
      command,
      operation_id,
      outcome,
      subject_record_id,
    })),
  ).toStrictEqual([
    { command: 'task.read', operation_id: null, outcome: 'applied', subject_record_id: recordId },
    { command: 'task.board', operation_id: null, outcome: 'applied', subject_record_id: null },
  ]);
  expect(after.filter((event) => event.operation_id === operationId)).toStrictEqual(
    before.filter((event) => event.operation_id === operationId),
  );
  expect(
    after.filter((event) => event.operation_id === operationId && event.outcome === 'applied'),
  ).toHaveLength(1);
}

it('single-mark score change uses the same whole caller pool for untouched A and changed B after reconnect', async () => {
  const a = await newIceTask(world);
  const b = await newIceTask(world);
  const set = (id: string, revision: number, impact: number) =>
    iceCommand(world, {
      command: 'task.set_scores',
      recordId: id,
      expectedRevision: revision,
      fields: { impact, confidence: 10, ease: 10 },
    });
  handle(await set(a.id, a.revision, 6));
  const markedB = handle(await set(b.id, b.revision, 5));
  const beforeA = await icePage(world, a.id);
  const beforeBoard = (await iceBoard(world)).find((row) => row.id === a.id);
  expect(beforeBoard?.rank).toStrictEqual(beforeA.rank);
  const operationId = randomUUID();
  const request = {
    command: 'task.set_scores',
    operationId,
    recordId: b.id,
    expectedRevision: markedB.revision,
    fields: { impact: 10 },
  } as const;
  const result = await iceCommand(world, request);
  handle(result);
  await world.db.closeSessions();
  const afterA = await icePage(world, a.id);
  const afterB = await icePage(world, b.id);
  expect(afterA.revision).toBe(beforeA.revision);
  expect(afterA.rank.number).toBeGreaterThan(beforeA.rank.number!);
  expect(afterB).toHaveProperty('scores', { impact: 10, confidence: 10, ease: 10 });
  expect((await iceBoard(world)).find((row) => row.id === a.id)?.rank).toStrictEqual(afterA.rank);
  expect(await iceCommand(world, request)).toStrictEqual(result);
  const audit = [...(await world.db.app.withBusiness(world.business, readAuditEvents))];
  expect(
    audit.filter((event) => event.operation_id === operationId && event.outcome === 'applied'),
  ).toHaveLength(1);
  await icePage(world, a.id);
  await iceBoard(world);
  const afterReads = await world.db.app.withBusiness(world.business, readAuditEvents);
  expectReadAuditOnly(audit, afterReads, a.id, operationId);
});

it('hidden B score changes do not alter the permitted A pool or disclose its identity', async () => {
  const a = await newIceTask(world);
  const b = handle(
    await iceCommand(world, {
      command: 'task.create',
      fields: { title: 'HIDDEN_MARK_POOL_CANARY' },
    }),
  );
  const marked = handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: a.id,
      expectedRevision: a.revision,
      fields: { impact: 6, confidence: 10, ease: 10 },
    }),
  );
  await world.db.app.withBusiness(world.business, (tx) =>
    grantTo(tx, world.reader, 'read', { kind: 'record', id: a.id }),
  );
  const before = await icePage(world, a.id, world.reader);
  expect(before.rank.number).toBe(1);
  handle(
    await iceCommand(world, {
      command: 'task.set_scores',
      recordId: b.id,
      expectedRevision: b.revision,
      fields: { impact: 10, confidence: 10, ease: 10 },
    }),
  );
  await world.db.closeSessions();
  const after = await icePage(world, a.id, world.reader);
  expect(after.revision).toBe(marked.revision);
  expect(after.rank).toStrictEqual(before.rank);
  expect(JSON.stringify(after)).not.toContain('HIDDEN_MARK_POOL_CANARY');
  expect(JSON.stringify(after)).not.toContain(b.id);
});

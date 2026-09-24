// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, the placement lane: what `task.update` and
// `task.reparent` answer when the body is wrong, and the parent cycle.
//
// Each case was a fault or a silent write at 6f13be8 (R1-THERMO-13, 14, 15, 17
// and 58). A malformed operand is refused by name and not answered as an
// outage (API.md, "An absent or mistyped operand is refused by name"), and a
// placement the server derives is refused before the database constraint sees
// it (`tasks/placement.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1-place: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

const refusal = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: answer };

describe.skipIf(serverUrl === undefined)('final review round 1: placement operands', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  const run = async (command: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, business, worker.presented, 'api', command as unknown as Request);

  const create = async (extra: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'placed' },
      ...extra,
    });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return made.recordId ?? '';
  };

  const read = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{
        readonly data: Record<string, unknown>;
        readonly revision: string;
      }>(
        `select data, revision::text as revision from records where business_id = $1 and id = $2`,
        [business, recordId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('read: gone');
      return { data: row.data, revision: Number(row.revision) };
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'final-r1-place');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'placer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('R1-THERMO-13: task.reparent needs a parentId, or an explicit null', () => {
    it.each([
      ['absent', {}],
      ['a number', { parentId: 5 }],
      ['an object', { parentId: {} }],
    ])('refuses parentId %s by name and writes nothing', async (_label, operand) => {
      const board = await create();
      const parent = await create({ board });
      const task = await create({ parentId: parent });
      const before = await read(task);

      const answer = await run({
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: before.revision,
        ...operand,
      });
      expect(refusal(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['parentId'] });

      const after = await read(task);
      expect(after.revision).toBe(before.revision);
      expect(after.data['parent']).toBe(parent);
      expect(after.data['board']).toBe(board);
    });

    it('still takes an explicit null as "top level, on the board it had"', async () => {
      const board = await create();
      const parent = await create({ board });
      const task = await create({ parentId: parent });
      const before = await read(task);
      const answer = await run({
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: before.revision,
        parentId: null,
      });
      expect(isCommandRefusal(answer)).toBe(false);
      const after = await read(task);
      expect(after.data['parent']).toBeUndefined();
      expect(after.data['board']).toBe(board);
    });
  });

  describe('R1-THERMO-14: task.update needs a field map', () => {
    it.each([
      ['absent', {}],
      ['null', { fields: null }],
      ['a string', { fields: 'x' }],
      ['an array', { fields: ['title'] }],
    ])('refuses fields %s by name and writes nothing', async (_label, operand) => {
      const task = await create();
      const before = await read(task);
      const answer = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: before.revision,
        ...operand,
      });
      expect(refusal(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['fields'] });
      expect((await read(task)).revision).toBe(before.revision);
    });
  });

  describe('R1-THERMO-15: task.reparent refuses a cycle of any length', () => {
    it('refuses A under its child B, and A keeps no parent', async () => {
      const a = await create();
      const b = await create({ parentId: a });
      const before = await read(a);
      const answer = await run({
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: a,
        expectedRevision: before.revision,
        parentId: b,
      });
      expect(refusal(answer)).toStrictEqual({ code: 'PLACEMENT_IS_DERIVED', names: ['parent'] });
      const after = await read(a);
      expect(after.revision).toBe(before.revision);
      expect(after.data['parent']).toBeUndefined();
    });

    it('refuses A under its grandchild C', async () => {
      const a = await create();
      const b = await create({ parentId: a });
      const c = await create({ parentId: b });
      const before = await read(a);
      const answer = await run({
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: a,
        expectedRevision: before.revision,
        parentId: c,
      });
      expect(refusal(answer)).toStrictEqual({ code: 'PLACEMENT_IS_DERIVED', names: ['parent'] });
      expect((await read(a)).revision).toBe(before.revision);
    });

    it('still moves a task under a task that is not its descendant', async () => {
      const a = await create();
      const b = await create({ parentId: a });
      const elsewhere = await create();
      const answer = await run({
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: b,
        expectedRevision: (await read(b)).revision,
        parentId: elsewhere,
      });
      expect(isCommandRefusal(answer)).toBe(false);
      expect((await read(b)).data['parent']).toBe(elsewhere);
    });
  });

  describe('R1-THERMO-17: task.update of board_section on a subtask', () => {
    it('refuses PLACEMENT_IS_DERIVED naming board_section, and writes nothing', async () => {
      const parent = await create({ board: await create() });
      const child = await create({ parentId: parent });
      const before = await read(child);
      const answer = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: child,
        expectedRevision: before.revision,
        fields: { board_section: randomUUID() },
      });
      expect(refusal(answer)).toStrictEqual({
        code: 'PLACEMENT_IS_DERIVED',
        names: ['board_section'],
      });
      const after = await read(child);
      expect(after.revision).toBe(before.revision);
      expect(after.data['board_section']).toBeUndefined();
    });

    it('still lets a top-level task change section within its board', async () => {
      const task = await create({ board: await create() });
      const section = randomUUID();
      const answer = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: (await read(task)).revision,
        fields: { board_section: section },
      });
      expect(isCommandRefusal(answer)).toBe(false);
      expect((await read(task)).data['board_section']).toBe(section);
    });
  });

  describe('R1-THERMO-58: a rank is never sent as a number', () => {
    it('refuses task.update of board_rank PLACEMENT_IS_DERIVED, and the rank stays', async () => {
      const task = await create();
      const before = await read(task);
      const answer = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: before.revision,
        fields: { board_rank: 5 },
      });
      expect(refusal(answer)).toStrictEqual({
        code: 'PLACEMENT_IS_DERIVED',
        names: ['board_rank'],
      });
      const after = await read(task);
      expect(after.revision).toBe(before.revision);
      expect(after.data['board_rank']).toBe(before.data['board_rank']);
    });
  });
});

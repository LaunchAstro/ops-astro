// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, the placement lane. Each case below was written
// first and failed at 3eb0cc1 (PROVE-BEFORE-FIX); the handback carries the
// red output.
//
// R2-AUTHORITY-3, R2-AUTHORITY-29 and R1-AUTHORITY-22's residual: task.reparent
// put a task on a board task.move refused, through the parent's board, and
// told an unreached parent from a fabricated one.
// R2-RUNTIME-18: a moved or reparented task's descendants kept the old board.
// R2-RUNTIME-19: task.create wrote a fabricated, foreign or trashed board.
// R2-THERMO-21: task.create took board and board_section from `fields`.
// R2-RUNTIME-13 and R2-THERMO-23: task.create's stateKey wrote a completed
// task with no stamp and no completion event.
// R2-AUTHORITY-32, R2-RUNTIME-58 and R2-RUNTIME-59: task.rank read any
// neighbour, anywhere, in any order, and could write a rank equal to one.
// R2-RUNTIME-54: a restored task tied with a sibling created while it was
// trashed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-records/src/commands/context.ts';
import { planTaskPlacement } from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r2-place: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];
type Answer = Awaited<ReturnType<typeof executeCommand>>;

/** What a caller sees: the refusal's bytes, or that it was applied. */
const seen = (answer: Answer | { readonly threw: string }) =>
  'threw' in answer
    ? answer
    : isCommandRefusal(answer)
      ? { code: answer.code, names: answer.names, fixes: answer.fixes }
      : { applied: true };

describe.skipIf(serverUrl === undefined)('final review round 2: placement', () => {
  let db: FreshDatabase;
  let business: string;
  let foreign: string;
  let worker: Member;
  let outsider: Member;
  let rhea: Member;
  let second: Database;

  const runIn = async (
    where: string,
    who: Member,
    command: Readonly<Record<string, unknown>>,
    on: Database = db.app,
  ): Promise<Answer | { readonly threw: string }> => {
    try {
      return await executeCommand(on, where, who.presented, 'api', {
        operationId: randomUUID(),
        ...command,
      } as unknown as Request);
    } catch (cause) {
      return { threw: String((cause as { code?: string }).code ?? cause) };
    }
  };

  const run = async (command: Readonly<Record<string, unknown>>, who: Member = worker) =>
    await runIn(business, who, command);

  const createIn = async (
    where: string,
    who: Member,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<string> => {
    const made = await runIn(where, who, {
      command: 'task.create',
      fields: { title: 'placed' },
      ...extra,
    });
    if ('threw' in made || isCommandRefusal(made)) {
      throw new Error(`create refused ${JSON.stringify(seen(made))}`);
    }
    return made.recordId ?? '';
  };

  const create = async (extra: Readonly<Record<string, unknown>> = {}) =>
    await createIn(business, worker, extra);

  const read = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{
        readonly data: Record<string, unknown>;
        readonly revision: string;
        readonly board: string | null;
        readonly rank: string | null;
        readonly completed_at: Date | null;
        readonly deleted_at: Date | null;
      }>(
        `select data, revision::text as revision, uuid_5::text as board, num_2::text as rank,
                ts_2 as completed_at, deleted_at
           from records where business_id = $1 and id = $2`,
        [business, recordId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('read: gone');
      return { ...row, revision: Number(row.revision), rank: Number(row.rank) };
    });

  const countTasks = async () =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        `select count(*)::text as n from records where business_id = $1`,
        [business],
      );
      return Number(rows[0]?.n);
    });

  const as = async (
    who: Member,
    command: string,
    recordId: string,
    extra: Readonly<Record<string, unknown>>,
  ) =>
    await run(
      { command, recordId, expectedRevision: (await read(recordId)).revision, ...extra },
      who,
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'final-r2-place');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'placer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
    foreign = await insertBusiness(db.app, 'final-r2-place-foreign');
    await installSpine(db.app, foreign);
    outsider = await enrol(db.app, foreign, 'outsider');
    await db.app.withBusiness(foreign, async (tx) => {
      await grantTo(tx, outsider, 'write');
    });
    rhea = await enrol(db.app, business, 'rhea');
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  describe('R2-AUTHORITY-3 / R2-AUTHORITY-29: task.reparent asks about the destination', () => {
    let rheaTask: string;
    let unreachedBoard: string;
    let unreachedParent: string;
    let foreignParent: string;

    beforeAll(async () => {
      rheaTask = await create();
      unreachedBoard = await create();
      unreachedParent = await create({ board: unreachedBoard });
      foreignParent = await createIn(foreign, outsider);
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: rheaTask });
      });
    });

    it('refuses rhea as task.move does, for an unreached, a foreign and a fabricated parent', async () => {
      const before = await read(rheaTask);
      const moved = seen(await as(rhea, 'task.move', rheaTask, { board: unreachedBoard }));
      expect(moved).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      const answers = [];
      for (const parentId of [unreachedParent, foreignParent, randomUUID()]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, on one task
        answers.push(seen(await as(rhea, 'task.reparent', rheaTask, { parentId })));
      }
      expect(answers[0]).toStrictEqual(moved);
      expect(answers[1]).toStrictEqual(moved);
      expect(answers[2]).toStrictEqual(moved);
      const after = await read(rheaTask);
      expect(after.revision).toBe(before.revision);
      expect(after.data['parent']).toBeUndefined();
      expect(after.board).toBeNull();
    });

    it('refuses rhea a parent she may write when it brings a board she may not', async () => {
      const hers = await create({ board: unreachedBoard });
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: hers });
      });
      const answer = seen(await as(rhea, 'task.reparent', rheaTask, { parentId: hers }));
      expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect((await read(rheaTask)).board).toBeNull();
    });

    it('lets a business-wide writer reparent the same task, which takes the parent’s board', async () => {
      const task = await create();
      const answer = seen(await as(worker, 'task.reparent', task, { parentId: unreachedParent }));
      expect(answer).toStrictEqual({ applied: true });
      expect((await read(task)).board).toBe(unreachedBoard);
    });
  });

  describe('R2-RUNTIME-18: a subtree follows its root’s board', () => {
    it('carries children and grandchildren on reparent and on move', async () => {
      const x = await create();
      const y = await create();
      const z = await create();
      const t = await create({ board: x });
      const c = await create({ parentId: t });
      const g = await create({ parentId: c });
      const p = await create({ board: y });
      expect((await read(g)).board).toBe(x);

      expect(seen(await as(worker, 'task.reparent', t, { parentId: p }))).toStrictEqual({
        applied: true,
      });
      expect([(await read(t)).board, (await read(c)).board, (await read(g)).board]).toStrictEqual([
        y,
        y,
        y,
      ]);

      expect(seen(await as(worker, 'task.reparent', t, { parentId: null }))).toStrictEqual({
        applied: true,
      });
      expect(seen(await as(worker, 'task.move', t, { board: z }))).toStrictEqual({
        applied: true,
      });
      expect([(await read(t)).board, (await read(c)).board, (await read(g)).board]).toStrictEqual([
        z,
        z,
        z,
      ]);
    });

    it('refuses task.move of a subtask naming board, and writes nothing', async () => {
      const t = await create({ board: await create() });
      const c = await create({ parentId: t });
      const before = await read(c);
      const answer = seen(await as(worker, 'task.move', c, { board: await create() }));
      expect(answer).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['board'] });
      const after = await read(c);
      expect(after.revision).toBe(before.revision);
      expect(after.board).toBe(before.board);
    });

    it('takes an unboarded subtree onto the new parent’s board', async () => {
      const y = await create();
      const t = await create();
      const c = await create({ parentId: t });
      const p = await create({ board: y });
      await as(worker, 'task.reparent', t, { parentId: p });
      expect((await read(c)).board).toBe(y);
    });
  });

  describe('R2-RUNTIME-19: task.create looks up a top-level board', () => {
    it('refuses a fabricated, a foreign and a trashed board alike, and writes nothing', async () => {
      const trashed = await create();
      await as(worker, 'task.trash', trashed, {});
      const foreignBoard = await createIn(foreign, outsider);
      const count = await countTasks();
      const answers = [];
      for (const board of [randomUUID(), foreignBoard, trashed]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        answers.push(seen(await run({ command: 'task.create', fields: { title: 'x' }, board })));
      }
      expect(answers[0]).toMatchObject({ code: 'NOT_FOUND', names: ['board'] });
      expect(answers[1]).toStrictEqual(answers[0]);
      expect(answers[2]).toStrictEqual(answers[0]);
      expect(await countTasks()).toBe(count);
    });

    it('still places a task on a live board', async () => {
      const board = await create();
      const task = await create({ board });
      expect((await read(task)).board).toBe(board);
    });
  });

  describe('R2-THERMO-21: task.create places only through its operands', () => {
    it('refuses a subtask with fields.board_section by name, not as an outage', async () => {
      const parent = await create();
      const count = await countTasks();
      const answer = seen(
        await run({
          command: 'task.create',
          parentId: parent,
          fields: { title: 'x', board_section: randomUUID() },
        }),
      );
      expect(answer).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['board_section'] });
      expect(await countTasks()).toBe(count);
    });

    it('does not rank a task sent with fields.board against another board’s siblings', async () => {
      const board = await create();
      await create({ board });
      await create({ board });
      const last = await create({ board });
      const answer = await run({ command: 'task.create', fields: { title: 'x', board } });
      if (!('threw' in answer) && !isCommandRefusal(answer)) {
        // After the last sibling on its own board (placement.ts, rankAfterSiblings).
        const made = await read(answer.recordId ?? '');
        expect(made.rank).toBe((await read(last)).rank + 1000);
      } else {
        expect(seen(answer)).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['board'] });
      }
    });

    it('does not put a subtask on a board its parent is not on', async () => {
      const parent = await create();
      const answer = await run({
        command: 'task.create',
        parentId: parent,
        fields: { title: 'x', board: await create() },
      });
      if (!('threw' in answer) && !isCommandRefusal(answer)) {
        expect((await read(answer.recordId ?? '')).board).toBeNull();
      } else {
        expect(seen(answer)).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['board'] });
      }
    });
  });

  describe('R2-RUNTIME-13 / R2-THERMO-23: a create cannot start a task completed', () => {
    it('never reads completed with no stamp', async () => {
      const count = await countTasks();
      const answer = await run({
        command: 'task.create',
        fields: { title: 'x' },
        stateKey: 'complete',
      });
      if (!('threw' in answer) && !isCommandRefusal(answer)) {
        const made = await read(answer.recordId ?? '');
        expect(made.completed_at).not.toBeNull();
      } else {
        expect(seen(answer)).toMatchObject({
          code: 'TRANSITION_PROTECTED',
          names: ['state=task.complete'],
        });
        expect(await countTasks()).toBe(count);
      }
    });

    it('still takes a started state the caller names', async () => {
      const task = await create({ stateKey: 'active' });
      expect((await read(task)).completed_at).toBeNull();
    });
  });

  describe('R2-AUTHORITY-32: task.rank asks about each neighbour', () => {
    it('gives rhea one answer for an unreached, a foreign and a fabricated neighbour', async () => {
      const hers = await create();
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: hers });
      });
      const unreached = await create();
      const foreignTask = await createIn(foreign, outsider);
      const before = await read(hers);
      const answers = [];
      for (const afterId of [unreached, foreignTask, randomUUID()]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, on one task
        answers.push(seen(await as(rhea, 'task.rank', hers, { afterId })));
      }
      expect(answers[0]).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(answers[1]).toStrictEqual(answers[0]);
      expect(answers[2]).toStrictEqual(answers[0]);
      const after = await read(hers);
      expect(after.revision).toBe(before.revision);
      expect(after.rank).toBe(before.rank);
    });
  });

  describe('R2-RUNTIME-59: task.rank neighbours are siblings, in order', () => {
    it('refuses a neighbour from another board, and writes nothing', async () => {
      const p = await create({ board: await create() });
      const s = await create({ parentId: p });
      const q = await create({ board: await create() });
      const before = await read(s);
      const answer = seen(await as(worker, 'task.rank', s, { afterId: q }));
      expect(answer).toMatchObject({ code: 'NOT_FOUND', names: ['neighbour'] });
      expect((await read(s)).rank).toBe(before.rank);
    });

    it('refuses neighbours sent in the wrong order, and writes nothing', async () => {
      const board = await create();
      const a = await create({ board });
      const b = await create({ board });
      const x = await create({ board });
      const before = await read(x);
      const answer = seen(await as(worker, 'task.rank', x, { afterId: b, beforeId: a }));
      expect(answer).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['neighbour'] });
      expect((await read(x)).rank).toBe(before.rank);
    });
  });

  describe('R2-RUNTIME-58: task.rank never writes a tie', () => {
    it('refuses the second of two clients sending the same pair, or ranks it apart', async () => {
      const board = await create();
      const a = await create({ board });
      const b = await create({ board });
      const x1 = await create({ board });
      const x2 = await create({ board });
      await as(worker, 'task.rank', x1, { afterId: a, beforeId: b });
      const again = await as(worker, 'task.rank', x2, { afterId: a, beforeId: b });
      const ranks = [(await read(a)).rank, (await read(x1)).rank, (await read(x2)).rank];
      if (!('threw' in again) && !isCommandRefusal(again)) {
        expect(ranks[2]).not.toBe(ranks[1]);
        expect(ranks[2]).toBeGreaterThan(ranks[0] ?? 0);
        expect(ranks[2]).toBeLessThan((await read(b)).rank);
      } else {
        expect(seen(again)).toMatchObject({ code: 'PLACEMENT_IS_DERIVED', names: ['neighbour'] });
      }
    });

    it('applies no tie across sixty inserts into one gap', async () => {
      const board = await create();
      const a = await create({ board });
      let before = await create({ board });
      const low = (await read(a)).rank;
      for (let i = 0; i < 60; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each insert reads the last
        const x = await create({ board });
        // oxlint-disable-next-line no-await-in-loop
        const answer = await as(worker, 'task.rank', x, { afterId: a, beforeId: before });
        if ('threw' in answer || isCommandRefusal(answer)) {
          expect(seen(answer)).toMatchObject({ code: 'PLACEMENT_IS_DERIVED' });
          break;
        }
        // oxlint-disable-next-line no-await-in-loop
        const placed = (await read(x)).rank;
        // oxlint-disable-next-line no-await-in-loop
        const high = (await read(before)).rank;
        expect(placed).toBeGreaterThan(low);
        expect(placed).toBeLessThan(high);
        before = x;
      }
    }, 60_000);

    it('makes a second create in one sibling set wait, so the two ranks differ', async () => {
      const parent = await create();
      const spine = await db.app.withBusiness(business, async (tx) => await readTaskSpine(tx));
      let other: Promise<Awaited<ReturnType<typeof runIn>>> | undefined;
      let held = 0;
      await db.app.withBusiness(business, async (tx) => {
        const placement = await planTaskPlacement(tx, spine.taskTypeId, { parentId: parent });
        if (isRecordsRefusal(placement)) throw new Error(placement.code);
        held = placement.boardRank;
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [
            business,
            randomUUID(),
            spine.taskTypeId,
            {
              title: 'held',
              key: `T-${800_000 + Math.floor(Math.random() * 99_999)}`,
              parent,
              board_rank: held,
            },
          ],
        );
        other = runIn(
          business,
          worker,
          { command: 'task.create', parentId: parent, fields: { title: 'racing' } },
          second,
        );
        // Give the other create the time to finish if nothing makes it wait.
        await new Promise((resolve) => {
          setTimeout(resolve, 750);
        });
      });
      const answer = await other;
      if (answer === undefined || 'threw' in answer || isCommandRefusal(answer)) {
        throw new Error(`the racing create failed: ${JSON.stringify(answer)}`);
      }
      expect((await read(answer.recordId ?? '')).rank).not.toBe(held);
    }, 20_000);
  });

  describe('R2-RUNTIME-54: a restored task does not tie with a newer sibling', () => {
    it('ranks a sibling created during the trash past the trashed one', async () => {
      const board = await create();
      await create({ board });
      const s2 = await create({ board });
      const trashed = await as(worker, 'task.trash', s2, {});
      if ('threw' in trashed || isCommandRefusal(trashed)) throw new Error('trash refused');
      const n = await create({ board });
      const restored = await run({
        command: 'task.restore',
        batchId: (trashed.detail as { batchId: string }).batchId,
      });
      expect(seen(restored)).toStrictEqual({ applied: true });
      const [rs2, rn] = [(await read(s2)).rank, (await read(n)).rank];
      expect(rn).not.toBe(rs2);

      const x = await create({ board });
      const [low, high] = rs2 < rn ? [s2, n] : [n, s2];
      await as(worker, 'task.rank', x, { afterId: low, beforeId: high });
      const placed = (await read(x)).rank;
      expect(placed).toBeGreaterThan(Math.min(rs2, rn));
      expect(placed).toBeLessThan(Math.max(rs2, rn));
    });
  });
});

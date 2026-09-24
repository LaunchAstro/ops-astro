// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, the placement lane's continuation. Each case failed
// at 05d6860 first (PROVE-BEFORE-FIX); the handback carries the red output.
//
// R2-THERMO-46: task.reparent took its per-business lock after the envelope
// locked the target, so a reparent holding the lock and waiting on a row
// deadlocked with one holding that row and waiting on the lock. The same
// class covers task.move's descendant carry against a reparent inside the
// subtree. Both are driven here as real commands; a third connection holds a
// row so the two queue on it in a known order.
// Ruling 4 (the R2-RUNTIME-58 class): task.move kept the moved task's rank,
// so it could tie with a task already on the destination board.
// R2-AUTHORITY-33 (from FR2-RUNTIME): an upper-case neighbour id names the
// same task as its lower-case form.

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

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r2-place-cont: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];
type Answer = Awaited<ReturnType<typeof executeCommand>> | { readonly threw: string };

const applied = (answer: Answer): boolean => !('threw' in answer) && !isCommandRefusal(answer);

describe.skipIf(serverUrl === undefined)('final review round 2: placement, continued', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let second: Database;
  let third: Database;

  const runOn = async (
    on: Database,
    command: Readonly<Record<string, unknown>>,
  ): Promise<Answer> => {
    try {
      return await executeCommand(on, business, worker.presented, 'api', {
        operationId: randomUUID(),
        ...command,
      } as unknown as Request);
    } catch (cause) {
      return { threw: String((cause as { code?: string }).code ?? cause) };
    }
  };

  const create = async (extra: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const made = await runOn(db.app, { command: 'task.create', fields: { title: 't' }, ...extra });
    if ('threw' in made || isCommandRefusal(made)) throw new Error('create refused');
    return made.recordId ?? '';
  };

  const read = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{
        readonly revision: string;
        readonly board: string | null;
        readonly parent: string | null;
        readonly rank: string | null;
      }>(
        `select revision::text as revision, uuid_5::text as board, uuid_4::text as parent,
                num_2::text as rank
           from records where business_id = $1 and id = $2`,
        [business, recordId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('read: gone');
      return { ...row, revision: Number(row.revision), rank: Number(row.rank) };
    });

  /** Deadlocks this database has recorded, flushed and read fresh. */
  const deadlocks = async (): Promise<number> => {
    await db.admin.execute(`select pg_stat_force_next_flush()`);
    await db.admin.execute(`select pg_stat_clear_snapshot()`);
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select deadlocks::text as n from pg_stat_database where datname = current_database()`,
    );
    return Number(rows[0]?.n);
  };

  /** Wait until `count` backends in this database are parked on a lock. */
  const awaitWaiting = async (count: number, deadline: number): Promise<void> => {
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} backends ever waited`);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await awaitWaiting(count, deadline);
  };

  /**
   * Hold `rowId` on the owner-free app connection, start `first` and wait for
   * it to queue on a lock, start `then` and wait for both, then release.
   */
  const raceBehind = async (
    rowId: string,
    first: Readonly<Record<string, unknown>>,
    then: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly answers: readonly Answer[]; readonly deadlocks: number }> => {
    const before = await deadlocks();
    let one: Promise<Answer> | undefined;
    let two: Promise<Answer> | undefined;
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
        business,
        rowId,
      ]);
      one = runOn(second, first);
      await awaitWaiting(1, Date.now() + 3_000);
      two = runOn(third, then);
      await awaitWaiting(2, Date.now() + 3_000);
    });
    const answers = [await one, await two].filter((answer) => answer !== undefined);
    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });
    return { answers, deadlocks: (await deadlocks()) - before };
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    second = connect(db.appUrl, { source: 'runtime' });
    third = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'final-r2-place-cont');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'placer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await third?.close();
    await db?.drop();
  });

  describe('R2-THERMO-46: the reparent lock comes before any row', () => {
    it('serialises a reparent of B against a reparent under B, with no deadlock', async () => {
      const [a, b, d] = [await create(), await create(), await create()];
      // B's own reparent queues on B first; the reparent under B then takes
      // A and the per-business lock and queues on B behind it.
      const raced = await raceBehind(
        b,
        { command: 'task.reparent', recordId: b, expectedRevision: 1, parentId: d },
        { command: 'task.reparent', recordId: a, expectedRevision: 1, parentId: b },
      );
      expect(raced.deadlocks).toBe(0);
      expect(raced.answers.map(applied)).toStrictEqual([true, true]);
      expect((await read(a)).parent).toBe(b);
      expect((await read(b)).parent).toBe(d);
    }, 20_000);

    it('serialises a move’s descendant carry against a reparent inside the subtree', async () => {
      const z = await create();
      const t = await create({ board: await create() });
      const c = await create({ parentId: t });
      const g = await create({ parentId: c });
      // G's reparent under T queues on G first; the move of T then locks T
      // and queues on G for the carry, while G's reparent wants T.
      const raced = await raceBehind(
        g,
        { command: 'task.reparent', recordId: g, expectedRevision: 1, parentId: t },
        { command: 'task.move', recordId: t, expectedRevision: 1, board: z },
      );
      expect(raced.deadlocks).toBe(0);
      expect(raced.answers.map(applied)).toStrictEqual([true, true]);
      expect([(await read(t)).board, (await read(c)).board, (await read(g)).board]).toStrictEqual([
        z,
        z,
        z,
      ]);
    }, 20_000);
  });

  describe('ruling 4: task.move ranks the task after the destination’s last', () => {
    it('does not tie with a task already on the destination board', async () => {
      const x = await create();
      const y = await create();
      const onX = await create({ board: x });
      const onY = await create({ board: y });
      const answer = await runOn(db.app, {
        command: 'task.move',
        recordId: onY,
        expectedRevision: (await read(onY)).revision,
        board: x,
      });
      expect(applied(answer)).toBe(true);
      expect((await read(onY)).rank).toBeGreaterThan((await read(onX)).rank);
    });
  });

  describe('R2-AUTHORITY-33: an upper-case neighbour names the same task', () => {
    it('ranks after an upper-case afterId as after its lower-case form', async () => {
      const board = await create();
      const a = await create({ board });
      const b = await create({ board });
      const x = await create({ board });
      const answer = await runOn(db.app, {
        command: 'task.rank',
        recordId: x,
        expectedRevision: (await read(x)).revision,
        afterId: a.toUpperCase(),
        beforeId: b.toUpperCase(),
      });
      expect(applied(answer)).toBe(true);
      const rank = (await read(x)).rank;
      expect(rank).toBeGreaterThan((await read(a)).rank);
      expect(rank).toBeLessThan((await read(b)).rank);
    });

    it('refuses an upper-case form of the task itself as its own neighbour', async () => {
      const board = await create();
      const a = await create({ board });
      const x = await create({ board });
      const answer = await runOn(db.app, {
        command: 'task.rank',
        recordId: x,
        expectedRevision: (await read(x)).revision,
        afterId: a,
        beforeId: x.toUpperCase(),
      });
      expect(
        !('threw' in answer) && isCommandRefusal(answer) && [answer.code, answer.names],
      ).toStrictEqual(['PLACEMENT_IS_DERIVED', ['neighbour']]);
    });
  });
});

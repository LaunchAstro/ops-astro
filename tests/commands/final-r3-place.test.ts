// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 3, the placement lane. Each case below was written
// first and failed at 61c167a (PROVE-BEFORE-FIX); the handback carries the
// red output.
//
// R2-RUNTIME-18, R3-THERMO-10 and R3-RUNTIME-11: a subtask trashed before its
// root moved or was reparented came back on the old board, under a parent on
// another one.
// R2-RUNTIME-15 and R1-THERMO-16: a restore or a create under a parent that a
// concurrent trash reached through an ancestor left a live child under a
// trashed parent, outside the batch.
// R2-RUNTIME-58: two creates in one sibling set, the parent spelled in two
// cases, took different sibling locks and tied.
// R3-SURFACE-22: task.move to the task's own board in upper case re-ranked it
// and rewrote its subtree.
//
// Interleavings are observed through pg_stat_activity rather than slept
// through, as in final-r2-fr2-trash.test.ts.

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
import { restoreBatch } from '../../packages/core-records/src/tasks/trash.ts';
import { readBoard } from '../../packages/core-records/src/reads/tasks.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r3-place: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
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

describe.skipIf(serverUrl === undefined)('final review round 3: placement', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let rhea: Member;
  let second: Database;
  let taskTypeId: string;

  const runIn = async (
    who: Member,
    command: Readonly<Record<string, unknown>>,
    on: Database = db.app,
  ): Promise<Answer | { readonly threw: string }> => {
    try {
      return await executeCommand(on, business, who.presented, 'api', {
        operationId: randomUUID(),
        ...command,
      } as unknown as Request);
    } catch (cause) {
      return { threw: String((cause as { code?: string }).code ?? cause) };
    }
  };

  const create = async (extra: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const made = await runIn(worker, { command: 'task.create', fields: { title: 'r3' }, ...extra });
    if ('threw' in made || isCommandRefusal(made)) {
      throw new Error(`create refused ${JSON.stringify(seen(made))}`);
    }
    return made.recordId ?? '';
  };

  const read = async (recordId: string) => {
    const rows = await db.admin.execute<{
      readonly data: Record<string, unknown>;
      readonly revision: string;
      readonly board: string | null;
      readonly rank: string | null;
      readonly deleted_at: Date | null;
      readonly trash_batch_id: string | null;
    }>(
      `select data, revision::text as revision, uuid_5::text as board, num_2::text as rank,
              deleted_at, trash_batch_id::text as trash_batch_id
         from records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('read: gone');
    return { ...row, revision: Number(row.revision), rank: Number(row.rank) };
  };

  const as = async (
    who: Member,
    command: string,
    recordId: string,
    extra: Readonly<Record<string, unknown>>,
    on: Database = db.app,
  ) =>
    await runIn(
      who,
      { command, recordId, expectedRevision: (await read(recordId)).revision, ...extra },
      on,
    );

  const trash = async (recordId: string): Promise<string> => {
    const answer = await as(worker, 'task.trash', recordId, {});
    if ('threw' in answer || isCommandRefusal(answer)) {
      throw new Error(`trash refused ${JSON.stringify(seen(answer))}`);
    }
    return String(answer.detail['batchId']);
  };

  const restore = async (batchId: string) =>
    seen(await runIn(worker, { command: 'task.restore', batchId }));

  const listed = async (board: string | null) =>
    await db.app.withBusiness(business, async (tx) =>
      (await readBoard(tx, taskTypeId, board)).map((task) => task.id),
    );

  /** Whether a backend in this database is parked on a lock, by the deadline. */
  const blockedOnLock = async (deadline: number): Promise<boolean> => {
    const rows = await db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        limit 1`,
    );
    if (rows.length > 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    return await blockedOnLock(deadline);
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr3place' });
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'final-r3-place');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'placer');
    rhea = await enrol(db.app, business, 'rhea');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'manage');
    });
    taskTypeId = (await db.app.withBusiness(business, async (tx) => await readTaskSpine(tx)))
      .taskTypeId;
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  describe('R2-RUNTIME-18, R3-THERMO-10, R3-RUNTIME-11: a restored subtask is on its parent’s board', () => {
    /** T on a, C under T, G under C; `trashed` is trashed, T is placed, the batch restored. */
    const schedule = async (
      trashed: 'child' | 'grandchild',
      place: (t: string, b: string) => Promise<unknown>,
      destination: 'board' | 'none',
    ) => {
      const a = await create();
      const b = await create();
      const t = await create({ board: a });
      const c = await create({ parentId: t });
      const g = await create({ parentId: c });
      const batch = await trash(trashed === 'child' ? c : g);
      await place(t, b);
      expect(await restore(batch)).toStrictEqual({ applied: true });
      const expected = destination === 'board' ? b : null;
      expect([(await read(c)).board, (await read(g)).board]).toStrictEqual([expected, expected]);
      const onA = await listed(a);
      expect(onA.includes(c) || onA.includes(g)).toBe(false);
      if (destination === 'board') expect(await listed(b)).toEqual(expect.arrayContaining([c, g]));
    };

    const moveTo = async (t: string, b: string) =>
      expect(seen(await as(worker, 'task.move', t, { board: b }))).toStrictEqual({ applied: true });

    it('after task.move of the root', async () => {
      await schedule('child', moveTo, 'board');
    });

    it('after task.reparent of the root under a parent on another board', async () => {
      await schedule(
        'child',
        async (t, b) => {
          const p = await create({ board: b });
          expect(seen(await as(worker, 'task.reparent', t, { parentId: p }))).toStrictEqual({
            applied: true,
          });
        },
        'board',
      );
    });

    it('after task.move of the root off every board', async () => {
      await schedule(
        'child',
        async (t) =>
          expect(seen(await as(worker, 'task.move', t, { board: null }))).toStrictEqual({
            applied: true,
          }),
        'none',
      );
    });

    it('for a grandchild trashed alone under a live child', async () => {
      await schedule('grandchild', moveTo, 'board');
    });

    it('when the move commits while the restore waits on the root', async () => {
      const a = await create();
      const b = await create();
      const t = await create({ board: a });
      const c = await create({ parentId: t });
      const batch = await trash(c);
      let restoring: Promise<ReturnType<typeof seen>> | undefined;
      let waited = false;
      await db.app.withBusiness(business, async (tx) => {
        // What the envelope does for task.move: the target, locked, first.
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          t,
        ]);
        await tx.query(
          `update records set data = jsonb_set(data, '{board}', to_jsonb($3::text))
            where business_id = $1 and id = $2`,
          [business, t, b],
        );
        restoring = runIn(worker, { command: 'task.restore', batchId: batch }, second).then(seen);
        waited = await blockedOnLock(Date.now() + 2_000);
      });
      expect(await restoring).toStrictEqual({ applied: true });
      expect(waited).toBe(true);
      expect((await read(c)).board).toBe(b);
    }, 20_000);
  });

  describe('R2-RUNTIME-15 and R1-THERMO-16: a trash reaching the parent through an ancestor', () => {
    it('takes a child restored under the parent meanwhile into its batch, or the restore is refused', async () => {
      const g = await create();
      const a = await create({ parentId: g });
      const c = await create({ parentId: a });
      const childBatch = await trash(c);
      let trashing: Promise<Answer | { readonly threw: string }> | undefined;
      let waited = false;
      await db.app.withBusiness(business, async (tx) => {
        const restored = await restoreBatch(tx, { batchId: childBatch });
        if (isRecordsRefusal(restored)) throw new Error(`restore refused ${restored.code}`);
        trashing = as(worker, 'task.trash', g, {}, second);
        waited = await blockedOnLock(Date.now() + 2_000);
      });
      expect(seen((await trashing) ?? { threw: 'no trash ran' })).toStrictEqual({ applied: true });
      const [parent, child] = [await read(a), await read(c)];
      expect(parent.deleted_at).not.toBeNull();
      expect(child.trash_batch_id).toBe(parent.trash_batch_id);
      expect(waited).toBe(true);
    }, 20_000);

    it('takes a child created under the parent meanwhile into its batch', async () => {
      const g = await create();
      const a = await create({ parentId: g });
      const x = randomUUID();
      let trashing: Promise<Answer | { readonly threw: string }> | undefined;
      let waited = false;
      await db.app.withBusiness(business, async (tx) => {
        // What task.create does: the parent read `for share`, then the insert.
        const placement = await planTaskPlacement(tx, taskTypeId, { parentId: a });
        if (isRecordsRefusal(placement)) throw new Error(placement.code);
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [
            business,
            x,
            taskTypeId,
            {
              title: 'held',
              key: `T-${700_000 + Math.floor(Math.random() * 99_999)}`,
              parent: a,
              board_rank: placement.boardRank,
            },
          ],
        );
        trashing = as(worker, 'task.trash', g, {}, second);
        waited = await blockedOnLock(Date.now() + 2_000);
      });
      expect(seen((await trashing) ?? { threw: 'no trash ran' })).toStrictEqual({ applied: true });
      const [parent, child] = [await read(a), await read(x)];
      expect(parent.deleted_at).not.toBeNull();
      expect(child.trash_batch_id).toBe(parent.trash_batch_id);
      expect(waited).toBe(true);
    }, 20_000);
  });

  describe('R2-RUNTIME-58: one sibling set is one lock, however the id is cased', () => {
    it('makes a create naming the parent in upper case wait, so the two ranks differ', async () => {
      const parent = await create();
      let other: Promise<Answer | { readonly threw: string }> | undefined;
      let held = 0;
      await db.app.withBusiness(business, async (tx) => {
        const placement = await planTaskPlacement(tx, taskTypeId, { parentId: parent });
        if (isRecordsRefusal(placement)) throw new Error(placement.code);
        held = placement.boardRank;
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [
            business,
            randomUUID(),
            taskTypeId,
            {
              title: 'held',
              key: `T-${800_000 + Math.floor(Math.random() * 99_999)}`,
              parent,
              board_rank: held,
            },
          ],
        );
        other = runIn(
          worker,
          { command: 'task.create', parentId: parent.toUpperCase(), fields: { title: 'racing' } },
          second,
        );
        await blockedOnLock(Date.now() + 1_000);
      });
      const answer = await other;
      if (answer === undefined || 'threw' in answer || isCommandRefusal(answer)) {
        throw new Error(`racing create refused ${JSON.stringify(answer)}`);
      }
      const racing = await read(answer.recordId ?? '');
      expect(racing.rank).not.toBe(held);
      expect(racing.data['parent']).toBe(parent);
    }, 20_000);
  });

  describe('R3-SURFACE-22: task.move compares the board however it is cased', () => {
    it('keeps the rank and the subtree on a section change to the same board in upper case', async () => {
      const b = await create();
      const first = await create({ board: b });
      const t = await create({ board: b });
      const last = await create({ board: b });
      const c = await create({ parentId: t });
      const section = await create();
      // Rhea may write the task and its board, not the subtask below it.
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: t });
        await grantTo(tx, rhea, 'write', { kind: 'record', id: b });
      });
      const [before, childBefore] = [await read(t), await read(c)];
      expect(before.rank).toBeGreaterThan((await read(first)).rank);
      expect(before.rank).toBeLessThan((await read(last)).rank);

      const answer = seen(
        await as(rhea, 'task.move', t, { board: b.toUpperCase(), boardSection: section }),
      );
      expect(answer).toStrictEqual({ applied: true });
      const [after, childAfter] = [await read(t), await read(c)];
      expect(after.rank).toBe(before.rank);
      expect(after.data['board']).toBe(b);
      expect(after.data['board_section']).toBe(section);
      expect(childAfter.data['board']).toBe(b);
      expect(childAfter.revision).toBe(childBefore.revision);
    });

    it('keeps them for a business-wide writer too, who is asked nothing more', async () => {
      const b = await create();
      await create({ board: b });
      const t = await create({ board: b });
      await create({ board: b });
      const c = await create({ parentId: t });
      const section = await create();
      const [before, childBefore] = [await read(t), await read(c)];
      const answer = seen(
        await as(worker, 'task.move', t, { board: b.toUpperCase(), boardSection: section }),
      );
      expect(answer).toStrictEqual({ applied: true });
      const [after, childAfter] = [await read(t), await read(c)];
      expect([after.rank, after.data['board']]).toStrictEqual([before.rank, b]);
      expect([childAfter.data['board'], childAfter.revision]).toStrictEqual([
        b,
        childBefore.revision,
      ]);
    });
  });
});

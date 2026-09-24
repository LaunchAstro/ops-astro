// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, the placement lane: the parent a new child is put
// under, and the board a task is moved onto.
//
// R1-THERMO-16: the PARENT_TRASHED check read the parent without a lock, so a
// trash of that parent committing between the check and the child's write
// left a live child under a trashed parent, outside the parent's batch.
//
// R1-AUTHORITY-22 and R1-THERMO-59: `moveTask` said a caller who may write the
// task but not the destination board is refused, and asked nothing. The
// destination is now a second authority question on the board's own record,
// and an unreached, a foreign and a fabricated board get one answer.

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
import { serialiseOn } from '../../packages/core-records/src/commands/prepare.ts';
import { declarationOf } from '../../packages/core-records/src/commands/surface.ts';
import {
  planTaskPlacement,
  wouldCloseParentLoop,
} from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1-place-reach: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

describe.skipIf(serverUrl === undefined)('final review round 1: placement reach', () => {
  let db: FreshDatabase;
  let business: string;
  let foreign: string;
  let worker: Member;
  let outsider: Member;
  let second: Database;

  /** A backend in this database parked on a lock, asked on the owner connection. */
  const awaitBlockedOnLock = async (deadline: number): Promise<void> => {
    const rows = await db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        limit 1`,
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error('the trash never waited on the parent: no interleaving was established');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    await awaitBlockedOnLock(deadline);
  };

  const runIn = async (where: string, who: Member, command: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, where, who.presented, 'api', command as unknown as Request);

  const run = async (command: Readonly<Record<string, unknown>>, who: Member = worker) =>
    await runIn(business, who, command);

  const createIn = async (
    where: string,
    who: Member,
    extra: Readonly<Record<string, unknown>> = {},
  ) => {
    const made = await runIn(where, who, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'reached' },
      ...extra,
    });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return made.recordId ?? '';
  };

  const create = async (extra: Readonly<Record<string, unknown>> = {}) =>
    await createIn(business, worker, extra);

  const read = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{
        readonly data: Record<string, unknown>;
        readonly revision: string;
        readonly deleted_at: Date | null;
        readonly trash_batch_id: string | null;
      }>(
        `select data, revision::text as revision, deleted_at, trash_batch_id from records
          where business_id = $1 and id = $2`,
        [business, recordId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('read: gone');
      return { ...row, revision: Number(row.revision) };
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'final-r1-place-reach');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'reacher');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
    foreign = await insertBusiness(db.app, 'final-r1-place-foreign');
    await installSpine(db.app, foreign);
    outsider = await enrol(db.app, foreign, 'outsider');
    await db.app.withBusiness(foreign, async (tx) => {
      await grantTo(tx, outsider, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  describe('R1-THERMO-16: the parent is locked for the PARENT_TRASHED check', () => {
    it('makes a trash of the parent wait, and then takes the new child into its batch', async () => {
      const parent = await create();
      const revision = (await read(parent)).revision;
      const child = randomUUID();
      let trash: Promise<Awaited<ReturnType<typeof run>>> | undefined;

      await db.app.withBusiness(business, async (tx) => {
        const spine = await readTaskSpine(tx);
        const placement = await planTaskPlacement(tx, spine.taskTypeId, { parentId: parent });
        if (isRecordsRefusal(placement)) throw new Error(placement.code);

        // On the second connection: `db.app` is `max: 1`, and this
        // transaction holds it.
        trash = executeCommand(second, business, worker.presented, 'api', {
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: parent,
          expectedRevision: revision,
        } as Request);
        // The trash is parked on the parent the check read, which is the
        // interleaving the defect needs, observed rather than slept through.
        await awaitBlockedOnLock(Date.now() + 3_000);

        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [
            business,
            child,
            spine.taskTypeId,
            { title: 'raced', key: `T-${900_000 + Math.floor(Math.random() * 99_999)}`, parent },
          ],
        );
      });

      const trashed = await trash;
      if (trashed === undefined || isCommandRefusal(trashed)) throw new Error('trash refused');
      const row = await read(child);
      expect(row.deleted_at).not.toBeNull();
      expect(row.trash_batch_id).toBe((await read(parent)).trash_batch_id);
    }, 20_000);
  });

  describe('R1-THERMO-15: two reparents cannot each close half of one loop', () => {
    it('makes the second wait for the first, and then refuses it', async () => {
      const a = await create();
      const b = await create();
      const bRevision = (await read(b)).revision;
      let reverse: Promise<Awaited<ReturnType<typeof run>>> | undefined;

      await db.app.withBusiness(business, async (tx) => {
        const spine = await readTaskSpine(tx);
        // A under B, as the envelope runs it: the per-business lock first
        // (R2-THERMO-46 moved it there), then the walk from B, which does not
        // reach A, and the write is held open.
        await serialiseOn(tx, declarationOf('task.reparent').serialise ?? '');
        expect(await wouldCloseParentLoop(tx, spine.taskTypeId, a, b)).toBe(false);
        await tx.query(
          `update records set data = data || jsonb_build_object('parent', $3::text)
            where business_id = $1 and id = $2`,
          [business, a, b],
        );
        // B under A, on the other connection: it would pass on what is committed.
        reverse = executeCommand(second, business, worker.presented, 'api', {
          command: 'task.reparent',
          operationId: randomUUID(),
          recordId: b,
          expectedRevision: bRevision,
          parentId: a,
        } as unknown as Request);
        await awaitBlockedOnLock(Date.now() + 3_000);
      });

      const answer = await reverse;
      expect(
        answer !== undefined && isCommandRefusal(answer) && [answer.code, answer.names],
      ).toStrictEqual(['PLACEMENT_IS_DERIVED', ['parent']]);
      expect((await read(b)).data['parent']).toBeUndefined();
    }, 20_000);
  });

  describe('R1-AUTHORITY-22 / R1-THERMO-59: task.move asks about the destination board', () => {
    let rhea: Member;
    let rheaTask: string;
    let unreached: string;
    let foreignBoard: string;

    beforeAll(async () => {
      rheaTask = await create();
      unreached = await create();
      foreignBoard = await createIn(foreign, outsider);
      rhea = await enrol(db.app, business, 'rhea');
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: rheaTask });
      });
    });

    const moveAsRhea = async (board: string) =>
      await run(
        {
          command: 'task.move',
          operationId: randomUUID(),
          recordId: rheaTask,
          expectedRevision: (await read(rheaTask)).revision,
          board,
        },
        rhea,
      );

    it('refuses an unreached, a foreign and a fabricated board alike, and writes nothing', async () => {
      const before = await read(rheaTask);
      const answers = [];
      for (const board of [unreached, foreignBoard, randomUUID()]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, on one task
        const answer = await moveAsRhea(board);
        answers.push(
          isCommandRefusal(answer)
            ? { code: answer.code, names: answer.names, fixes: answer.fixes }
            : { applied: true },
        );
      }
      expect(answers[0]).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(answers[1]).toStrictEqual(answers[0]);
      expect(answers[2]).toStrictEqual(answers[0]);
      const after = await read(rheaTask);
      expect(after.revision).toBe(before.revision);
      expect(after.data['board']).toBeUndefined();
    });

    it('moves the task onto a board she holds write on', async () => {
      const hers = await create();
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, rhea, 'write', { kind: 'record', id: hers });
      });
      const answer = await moveAsRhea(hers);
      expect(isCommandRefusal(answer)).toBe(false);
      expect((await read(rheaTask)).data['board']).toBe(hers);
    });

    it('lets a business-wide writer move the same task onto the unreached board', async () => {
      const answer = await run({
        command: 'task.move',
        operationId: randomUUID(),
        recordId: rheaTask,
        expectedRevision: (await read(rheaTask)).revision,
        board: unreached,
      });
      expect(isCommandRefusal(answer)).toBe(false);
      expect((await read(rheaTask)).data['board']).toBe(unreached);
    });

    it('still answers NOT_FOUND naming board to a business-wide writer for a fabricated one', async () => {
      const answer = await run({
        command: 'task.move',
        operationId: randomUUID(),
        recordId: rheaTask,
        expectedRevision: (await read(rheaTask)).revision,
        board: randomUUID(),
      });
      expect(isCommandRefusal(answer) && [answer.code, answer.names]).toStrictEqual([
        'NOT_FOUND',
        ['board'],
      ]);
    });
  });
});

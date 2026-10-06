// SPDX-License-Identifier: AGPL-3.0-only
//
// A move asked about the descendants it locked, then walked the subtree again
// to rewrite it. A grandchild committed under a locked child in between was
// rewritten onto the new board, though its writer was never asked about it.
//
// A creation holds an existing child `for share`; the move parks on that
// child, observed through pg_blocking_pids rather than slept through; the
// grandchild commits before the wait ends. The mover's grants are record
// grants cut from a delegable root grant, so each carries its parent link.
// A descendant a trash commits while the move waits on it keeps its board.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { planTaskPlacement } from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import { trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-moved-subtree-carries-only-descendants-its-mover-was-asked-about: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];
type Answer = Awaited<ReturnType<typeof executeCommand>>;

interface World {
  readonly db: FreshDatabase;
  readonly second: Database;
  readonly business: string;
  readonly worker: Member;
  readonly grantor: Member;
  readonly delegable: string;
}

let world: World;

async function setUp(): Promise<World> {
  const db = await createFreshDatabase({ part: 'f' });
  const second = connect(db.appUrl, { source: 'runtime' });
  const business = await insertBusiness(db.app, 'move-asks-each-descendant');
  await installSpine(db.app, business);
  const worker = await enrol(db.app, business, 'placer');
  const grantor = await enrol(db.app, business, 'grantor');
  const delegable = await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, worker, 'write');
    return await grantTo(tx, grantor, 'write', WHOLE_BUSINESS, true);
  });
  return { db, second, business, worker, grantor, delegable };
}

async function create(extra: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const made = await executeCommand(world.db.app, world.business, world.worker.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'placed' },
    ...extra,
  } as unknown as Request);
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  return made.recordId ?? '';
}

async function read(recordId: string) {
  return await world.db.app.withBusiness(world.business, async (tx) => {
    const rows = await tx.query<{
      readonly data: Record<string, unknown>;
      readonly revision: string;
      readonly deleted_at: Date | null;
    }>(
      `select data, revision::text as revision, deleted_at from records
        where business_id = $1 and id = $2`,
      [world.business, recordId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('read: gone');
    return { data: row.data, revision: Number(row.revision), trashed: row.deleted_at !== null };
  });
}

/** A mover holding `write` on each record named, cut from the grantor's delegable grant. */
async function moverOn(name: string, ids: readonly string[]): Promise<Member> {
  const mover = await enrol(world.db.app, world.business, name);
  await world.db.app.withBusiness(world.business, async (tx) => {
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      const derived = await issueGrant(tx, [{ kind: 'person', id: world.grantor.personId }], {
        subject: { kind: 'person', id: mover.personId },
        scope: { kind: 'record', id },
        collection: 'task',
        action: 'write',
        parentGrantId: world.delegable,
        grantedByActorId: world.grantor.actorId,
      });
      if (!derived.ok) throw new Error(`moverOn: refused ${derived.refusal.code}`);
    }
  });
  return mover;
}

/** A backend parked on a row lock `blocker` holds, asked on the owner connection. */
async function awaitRowWaitOn(blocker: number, deadline: number): Promise<void> {
  const rows = await world.db.admin.execute<{ readonly pid: number }>(
    `select pid from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and wait_event <> 'advisory' and $1::int = any(pg_blocking_pids(pid))
      limit 1`,
    [blocker],
  );
  if (rows.length > 0) return;
  if (Date.now() > deadline) {
    throw new Error('the move never waited on the held child: no interleaving was established');
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  await awaitRowWaitOn(blocker, deadline);
}

interface Race {
  readonly root: string;
  readonly child: string;
  readonly grandchild: string;
  readonly boardB: string;
  readonly mover: Member;
}

/** Start the move on `second`, parked on a row lock `tx` holds (`db.app` is `max: 1`). */
async function startMoveBehind(
  tx: TenantQuery,
  race: Race,
): Promise<{ readonly move: Promise<Answer> }> {
  const held = await tx.query<{ readonly pid: number; readonly revision: string }>(
    `select pg_backend_pid() as pid, revision::text as revision from records
      where business_id = $1 and id = $2`,
    [world.business, race.root],
  );
  const move = executeCommand(world.second, world.business, race.mover.presented, 'api', {
    command: 'task.move',
    operationId: randomUUID(),
    recordId: race.root,
    expectedRevision: Number(held[0]?.revision),
    board: race.boardB,
  } as unknown as Request);
  await awaitRowWaitOn(held[0]?.pid ?? 0, Date.now() + 3_000);
  return { move };
}

/** Hold the child `for share` as a creation does, start the move, commit the grandchild. */
async function moveWhileGrandchildCommits(race: Race): Promise<Answer | undefined> {
  let move: Promise<Answer> | undefined;
  await world.db.app.withBusiness(world.business, async (tx) => {
    const spine = await readTaskSpine(tx);
    const placement = await planTaskPlacement(tx, spine.taskTypeId, { parentId: race.child });
    if (isRecordsRefusal(placement)) throw new Error(placement.code);
    ({ move } = await startMoveBehind(tx, race));
    await tx.query(
      `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
      [
        world.business,
        race.grandchild,
        spine.taskTypeId,
        {
          title: 'committed meanwhile',
          key: `T-${900_000 + Math.floor(Math.random() * 99_999)}`,
          parent: race.child,
          board: placement.board,
        },
      ],
    );
  });
  return await move;
}

/**
 * Root, child and grandchild on board A, moved to B by a mover who may write
 * all four, while a trash of the grandchild holds it and then commits.
 * Answers the move, the grandchild's revision as the trash left it, the ids.
 */
async function moveWhileGrandchildIsTrashed() {
  const [boardA, boardB] = [await create(), await create()];
  const root = await create({ board: boardA });
  const child = await create({ parentId: root });
  const grandchild = await create({ parentId: child });
  const mover = await moverOn('trash-mover', [root, child, grandchild, boardB]);
  const race = { root, child, grandchild, boardB, mover };
  let move: Promise<Answer> | undefined;
  const trashedAt = await world.db.app.withBusiness(world.business, async (tx) => {
    const trashed = await trashSubtree(tx, {
      rootId: race.grandchild,
      actorId: world.worker.actorId,
    });
    if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
    ({ move } = await startMoveBehind(tx, race));
    const rows = await tx.query<{ readonly revision: string }>(
      `select revision::text as revision from records where business_id = $1 and id = $2`,
      [world.business, race.grandchild],
    );
    return Number(rows[0]?.revision);
  });
  return { answer: await move, trashedAt, boardA, ...race };
}

type Tree = Omit<Race, 'mover'>;

/**
 * A root on board A with one child, moved to board B by the mover `moverFor`
 * enrols. Answers the move, the boards of the root, the child, the grandchild,
 * A and B afterwards, and the root's revision before.
 */
async function moveDuringGrandchild(grandchild: string, moverFor: (tree: Tree) => Promise<Member>) {
  const [boardA, boardB] = [await create(), await create()];
  const root = await create({ board: boardA });
  const child = await create({ parentId: root });
  const tree = { root, child, grandchild, boardB };
  const rootRevision = (await read(root)).revision;
  const answer = await moveWhileGrandchildCommits({ ...tree, mover: await moverFor(tree) });
  if (answer === undefined) throw new Error('the move never started');
  const boards = [];
  for (const id of [root, child, grandchild, boardA, boardB]) {
    // oxlint-disable-next-line no-await-in-loop -- read back in order
    boards.push((await read(id)).data['board']);
  }
  return { answer, boardA, boardB, boards, root, rootRevision };
}

describe.skipIf(serverUrl === undefined)(
  'a move carries only descendants its mover was asked about',
  () => {
    beforeAll(async () => {
      world = await setUp();
    }, 60_000);

    afterAll(async () => {
      await world?.second.close();
      await world?.db.drop();
    });

    it('refuses a mover never asked about the grandchild, and moves nothing', async () => {
      const raced = await moveDuringGrandchild(
        randomUUID(),
        async ({ root, child, boardB }) => await moverOn('mover', [root, child, boardB]),
      );
      expect(isCommandRefusal(raced.answer) && raced.answer.code).toBe('SCOPE_NOT_GRANTED');
      const { boardA } = raced;
      expect(raced.boards).toStrictEqual([boardA, boardA, boardA, undefined, undefined]);
      expect((await read(raced.root)).revision).toBe(raced.rootRevision);
    }, 20_000);

    it('still carries the whole subtree for a mover who may write the grandchild too', async () => {
      const raced = await moveDuringGrandchild(
        randomUUID(),
        async ({ root, child, grandchild, boardB }) =>
          await moverOn('whole-mover', [root, child, grandchild, boardB]),
      );
      expect(isCommandRefusal(raced.answer)).toBe(false);
      const { boardB } = raced;
      expect(raced.boards).toStrictEqual([boardB, boardB, boardB, undefined, undefined]);
    }, 20_000);

    it('leaves a descendant trashed while the move waits on it where it was', async () => {
      const raced = await moveWhileGrandchildIsTrashed();
      const { root, child, grandchild, boardA, boardB } = raced;
      expect(raced.answer !== undefined && isCommandRefusal(raced.answer)).toBe(false);
      expect([(await read(root)).data['board'], (await read(child)).data['board']]).toStrictEqual([
        boardB,
        boardB,
      ]);
      const left = await read(grandchild);
      expect([left.trashed, left.data['board'], left.revision]).toStrictEqual([
        true,
        boardA,
        raced.trashedAt,
      ]);
    }, 20_000);
  },
);

// SPDX-License-Identifier: AGPL-3.0-only
//
// A move walks its subtree again after each lock wait, until a walk finds
// nothing new, and rewrites only the rows it locked and asked about.
//
// Each pass that finds new descendants asks the mover's authority again: a
// whole-business grant that lapses while a later pass waits on a descendant
// committed after the first pass no longer covers it.
//
// The repeated walk and the rewrite stay inside one business and one client:
// another business's subtree, its concurrent creation and a row there that
// names this business's task as its parent are untouched and unnamed; another
// client's tasks on the same board are untouched, and another client's task
// filed under the moved subtree is not carried.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addClient, enrol, grantTo, installSpine } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  awaitRowWaitOn,
  create,
  holdUnder,
  moverOn,
  read,
  releaseHeld,
  run,
  setUpWorld,
  snapshot,
  startMove,
  tearDownWorld,
  world,
  type Answer,
} from './subtree-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-moved-subtree-asks-afresh-each-pass-and-stays-inside-its-business-and-client: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const codeOf = (answer: Answer): string | false => isCommandRefusal(answer) && answer.code;

/** Boards A and B, a root on A, and its children, as the worker makes them. */
async function treeOnA(children: number) {
  const [boardA, boardB] = [await create(), await create()];
  const root = await create({ board: boardA });
  const kids = [];
  for (let n = 0; n < children; n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one sibling set, ranked in order
    kids.push(await create({ parentId: root }));
  }
  return { boardA, boardB, root, kids, revision: (await read(root)).revision };
}

/** The database clock plus `seconds`, and a wait until the clock has passed it. */
async function lapseIn(seconds: number) {
  const rows = await world().db.admin.execute<{ readonly at: Date }>(
    `select now() + make_interval(secs => $1) as at`,
    [seconds],
  );
  const at = rows[0]?.at ?? new Date();
  const passed = async (): Promise<void> => {
    const past = await world().db.admin.execute<{ readonly past: boolean }>(
      `select clock_timestamp() > $1::timestamptz as past`,
      [at],
    );
    if (past[0]?.past === true) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await passed();
  };
  return { at, passed };
}

/**
 * The first pass waits behind C's creation (G) and D's holder; G commits, H's
 * creation takes G, D's holder commits so the first pass asks while the grant
 * is live, and the second pass waits on G until the grant has lapsed.
 */
async function moveAcrossALapse() {
  const { boardA, boardB, root, kids, revision } = await treeOnA(2);
  const [c, d] = kids as [string, string];
  const [g, h] = [randomUUID(), randomUUID()];
  const lapse = await lapseIn(4);
  const mover = await moverOn('lapsing', [root, boardB, { kind: 'business', id: null }], lapse.at);
  const { db, third, fourth } = world();
  const underC = await holdUnder(db.app, c, { id: g });
  const onD = await holdUnder(third, d);
  const move = startMove(mover, root, revision, boardB);
  await awaitRowWaitOn([underC.pid, onD.pid]);
  await underC.commit();
  const underG = await holdUnder(fourth, g, { id: h });
  await onD.commit();
  await awaitRowWaitOn([underG.pid]);
  await lapse.passed();
  await underG.commit();
  return { answer: await move, boardA, ids: [root, c, d, g, h] };
}

describe.skipIf(serverUrl === undefined)('a moved subtree, asked afresh on every pass', () => {
  beforeAll(async () => {
    await setUpWorld('move-asks-afresh');
  }, 60_000);

  afterEach(releaseHeld);

  afterAll(async () => {
    await tearDownWorld();
  });

  it('refuses descendants found after a whole-business grant lapsed mid-move, and moves nothing', async () => {
    const raced = await moveAcrossALapse();
    expect(codeOf(raced.answer)).toBe('SCOPE_NOT_GRANTED');
    expect((await snapshot(raced.ids)).map((row) => row.board)).toStrictEqual(
      raced.ids.map(() => raced.boardA),
    );
  }, 30_000);

  describe('the business boundary', () => {
    it('leaves another business’s subtree, its creation and its cross-linked row untouched and unnamed', async () => {
      const raced = await moveBesideAnotherBusiness();
      expect(codeOf(raced.answer)).toBe(false);
      expect(raced.moved.map((row) => row.board)).toStrictEqual([
        raced.boardB,
        raced.boardB,
        raced.boardB,
      ]);
      expect(raced.foreignAfter).toStrictEqual(raced.foreignBefore);
      expect(raced.foreignCreated).toStrictEqual({ board: raced.foreignBoard, revision: 1 });
      const said = JSON.stringify(raced.answer);
      for (const id of raced.foreignIds) expect(said).not.toContain(id);
    }, 30_000);
  });

  describe('the client boundary', () => {
    it('does not carry another client’s task filed under the subtree, nor touch that client’s tasks on the board', async () => {
      const raced = await moveOverAnotherClientsTask();
      expect(codeOf(raced.answer)).toBe('SCOPE_NOT_GRANTED');
      expect(raced.after).toStrictEqual(raced.before);
      expect(raced.filed).toStrictEqual({ board: raced.boardA, revision: 1 });
      const said = JSON.stringify(raced.answer);
      for (const id of raced.otherClientIds) expect(said).not.toContain(id);
    }, 30_000);
  });
});

/**
 * The worker moves a root and its child while a creation under the child
 * holds it; meanwhile the other business commits a creation of its own, and
 * carries a row whose parent names the child.
 */
async function moveBesideAnotherBusiness() {
  const other = await otherBusiness();
  const { boardB, root, kids, revision } = await treeOnA(1);
  const [c] = kids as [string];
  const linked = await other.linkTo(c);
  const foreign = [...other.ids, linked];
  const foreignBefore = await snapshot(foreign, other.business);
  const [g, z] = [randomUUID(), randomUUID()];
  const underC = await holdUnder(world().db.app, c, { id: g });
  const there = await holdUnder(world().third, other.child, { id: z }, other.business);
  const move = startMove(world().worker, root, revision, boardB);
  await awaitRowWaitOn([underC.pid]);
  await there.commit();
  await underC.commit();
  return {
    answer: await move,
    boardB,
    moved: await snapshot([root, c, g]),
    foreignBefore,
    foreignAfter: await snapshot(foreign, other.business),
    foreignCreated: await read(z, other.business),
    foreignBoard: other.board,
    foreignIds: [other.business, ...foreign, z],
  };
}

/**
 * Client X's root and child on board A beside client Y's, moved by a writer of
 * X's records only, while a task of client Y is filed under X's child.
 */
async function moveOverAnotherClientsTask() {
  const { x, y } = { x: randomUUID(), y: randomUUID() };
  const { boardA, boardB, root } = await treeOnA(0);
  await onClient(root, x);
  const c = await create({ parentId: root });
  const yRoot = await create({ board: boardA });
  await onClient(yRoot, y);
  const yChild = await create({ parentId: yRoot });
  const mover = await moverOn('client-x-mover', [root, c, boardB]);
  const watched = [root, c, yRoot, yChild];
  const before = await snapshot(watched);
  const g = randomUUID();
  const underC = await holdUnder(world().db.app, c, { id: g, data: { client: y } });
  const move = startMove(mover, root, before[0]?.revision ?? 0, boardB);
  await awaitRowWaitOn([underC.pid]);
  await underC.commit();
  return {
    answer: await move,
    boardA,
    before,
    after: await snapshot(watched),
    filed: await read(g),
    otherClientIds: [y, yRoot, yChild, g],
  };
}

/** Put a top-level task on a client of this business, made for the case. */
async function onClient(task: string, client: string): Promise<void> {
  const { db, business, worker } = world();
  await addClient(db.app, business, client, worker);
  await run({
    command: 'task.set_party',
    recordId: task,
    expectedRevision: (await read(task)).revision,
    fields: { client },
  });
}

/**
 * A second business with its own writer, a root on its own board and a child
 * under it. `linkTo` writes a row there whose parent names a task of the first
 * business: a link the walk must not follow across the boundary.
 */
async function otherBusiness() {
  const { db } = world();
  const business = await insertBusiness(db.app, 'move-asks-afresh-other');
  await installSpine(db.app, business);
  const writer = await enrol(db.app, business, 'other-writer');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, writer, 'write');
  });
  const board = await create({}, writer, business);
  const root = await create({ board }, writer, business);
  const child = await create({ parentId: root }, writer, business);
  const linkTo = async (task: string) => {
    const made = await create({ board }, writer, business);
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `update records set data = data || jsonb_build_object('parent', $3::text)
          where business_id = $1 and id = $2`,
        [business, made, task],
      );
    });
    return made;
  };
  return { business, board, child, ids: [board, root, child], linkTo };
}

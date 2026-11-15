// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4a (#2514), the races, each on separate connections ordered by what the database
// reports: two crossing folder moves queued on the tree lock leave one applied and the other
// refused, never a cycle; a rename racing a create of the same name leaves one folder of that name
// and a refusal, never a fault.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { codeOrApplied, folderIn, treeOf } from './docs-tree.ts';
import { grantTo } from './fixture.ts';
import { WHOLE, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'docs-folder-move-races: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dfr');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const folder = async (name: string) => await folderIn(w, w.alpha, w.ada, name);
const tree = async () => await treeOf(w, w.alpha);

/** A move's tree lock, the statement two crossing moves queue in. */
const LOCK_TREE = 'from public.docs_folders where business_id = $1 order by id for update';

/** Waits until `count` backends wait on a row lock in a statement containing `statement`. */
async function waitersOn(statement: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await w.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and strpos(query, $1) > 0`,
      [statement],
    );
    if ((row?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`fewer than ${count} backends reached a lock wait in "${statement}"`);
}

const moveOn = (db: ReturnType<typeof connect>, folderId: string, parentId: string) =>
  executeCommand(db, w.alpha, w.ada.presented, 'api', {
    command: 'docs.move_folder',
    operationId: randomUUID(),
    folderId,
    parentId,
  } as never);

it.skipIf(serverUrl === undefined)(
  'two crossing moves (A under B, B under A) queued on the tree lock leave one applied and the other refused, never a cycle',
  async () => {
    const a = await folder(`Cross A ${randomUUID().slice(0, 6)}`);
    const b = await folder(`Cross B ${randomUUID().slice(0, 6)}`);
    const [first, second] = [connect(w.db.appUrl), connect(w.db.appUrl)];
    try {
      const held = await hold(w.db.appUrl, w.alpha, async (tx) => {
        await tx.query(`select id ${LOCK_TREE}`, [tx.businessId]);
      });
      let moves: Promise<CommandResult>[] = [];
      try {
        moves = [moveOn(first, a, b)];
        await waitingOn(w.db.admin, 'transactionid', LOCK_TREE);
        moves.push(moveOn(second, b, a));
        await waitersOn(LOCK_TREE, 2);
      } finally {
        await held.letGo();
      }
      const codes = (await Promise.all(moves)).map((answer) => codeOrApplied(answer)).toSorted();
      expect(codes).toStrictEqual(['FIELD_VALUE_INVALID', 'applied']);
      const after = await tree();
      expect([after[a]?.[0], after[b]?.[0]].filter((parent) => parent === null)).toHaveLength(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a rename racing a create of the same name at the top leaves one folder of that name, and the rename refused UNIQUE_VALUE_TAKEN, not a fault',
  async () => {
    const name = `Raced ${randomUUID().slice(0, 6)}`;
    const renaming = await folder(`Before race ${randomUUID().slice(0, 6)}`);
    const renamer = connect(w.db.appUrl);
    try {
      const creating = await hold(w.db.appUrl, w.alpha, async (tx) => {
        await tx.query(
          `insert into public.docs_folders (business_id, id, name, created_by_actor_id)
           values ($1, $2, $3, $4)`,
          [tx.businessId, randomUUID(), name, w.ada.actorId],
        );
      });
      let renamed: Promise<CommandResult> | undefined;
      try {
        renamed = executeCommand(renamer, w.alpha, w.ada.presented, 'api', {
          command: 'docs.rename_folder',
          operationId: randomUUID(),
          folderId: renaming,
          name,
        } as never);
        await waitingOn(w.db.admin, 'transactionid', 'update public.docs_folders');
      } finally {
        await creating.letGo();
      }
      expect(outcomeOf(await renamed)).toStrictEqual({
        code: 'UNIQUE_VALUE_TAKEN',
        names: ['name'],
      });
      const named = Object.values(await tree()).filter(([, each]) => each === name);
      expect(named).toHaveLength(1);
    } finally {
      await renamer.close();
    }
  },
);

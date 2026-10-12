// SPDX-License-Identifier: AGPL-3.0-only
// A member holding task read across the business, and a record grant on one
// task, reads the board with no board. Their business grant is revoked after
// the board admitted them and before it reads its rows, by a second
// connection that commits. The answer may say nothing is withheld only when
// it serves every task; a board that served the record grant's task alone has
// withheld the rest, and a record-grant reader is told no count at all.
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
// `readableScope` (core-records authority/readable-scope.ts). The board asks
// it for read when it admits the reader, then for decide just before its rows.
const SCOPE = 'select distinct e.scope_kind, e.scope_id';

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('p10withheld', 'p10withheld');
  owner = await w.decider('Withheld owner');
}, 180_000);
afterAll(async () => await w?.drop());

function observedDatabase(
  after: (statement: string, parameters: readonly unknown[] | undefined) => Promise<void>,
): Database {
  return {
    log: w.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await w.db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            await after(statement, parameters);
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

it('a board that tells its reader nothing is withheld serves every task after their business grant is revoked mid-read', async () => {
  const held = await w.create(owner, { title: 'Withheld held task' });
  const other = await w.create(owner, { title: 'Withheld other task' });
  const reader = await w.member('Withheld reader', ['read']);
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'record', id: held.id });
  });
  let revoked = false;
  const observed = observedDatabase(async (statement, parameters) => {
    if (revoked || !statement.includes(SCOPE) || parameters?.[1] !== 'decide') return;
    revoked = true;
    const ended = await w.db.admin.execute(
      `update public.grants set revoked_at = now()
        where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'read'
          and scope_kind = 'business' returning id`,
      [w.business, reader.personId],
    );
    expect(ended).toHaveLength(1);
  });
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(revoked).toBe(true);
  if (!('tasks' in answer)) throw new Error(`task.board refused: ${JSON.stringify(answer)}`);
  const ids = (answer.tasks as unknown as readonly { readonly id: string }[]).map((row) => row.id);
  expect(ids).toContain(held.id);
  const told = {
    withheld: 'withheld' in answer ? answer.withheld : 'no count',
    servedOther: ids.includes(other.id),
  };
  expect([
    { withheld: 'no count', servedOther: false },
    { withheld: 0, servedOther: true },
  ]).toContainEqual(told);
}, 60_000);

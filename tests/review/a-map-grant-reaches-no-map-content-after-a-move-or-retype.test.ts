// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { gate } from '../support/lock-waits.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('sol1364races', 'sol1364races');
  owner = await w.decider('Sol race owner');
}, 180_000);
afterAll(async () => await w?.drop());

function signal(): { promise: Promise<void>; resolve: () => void } {
  const { promise, release } = gate();
  return { promise, resolve: release };
}

function observedDatabase(
  before: (statement: string, parameters?: readonly unknown[]) => Promise<void>,
  after: (
    statement: string,
    parameters: readonly unknown[] | undefined,
    rows: readonly unknown[],
  ) => Promise<void>,
): Database {
  return {
    log: w.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await w.db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            await before(statement, parameters);
            const rows = await tx.query<Row>(statement, parameters);
            await after(statement, parameters, rows);
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

it('an expired map grant reaches no later map content when its last ticket leaves during the lock wait', async () => {
  const map = await w.create(owner, { title: 'Before expiry' }, { taskType: 'map' });
  const other = await w.create(owner, { title: 'Other map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Departing ticket' }, { parentId: map.id });
  const reader = await w.member('Sol empty expansion reader', ['read'], {
    kind: 'record',
    id: map.id,
  });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');
  const [grant] = await w.db.admin.execute<{ id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'read'
      returning id`,
    [w.business, reader.personId],
  );
  if (grant === undefined) throw new Error('reader grant missing');
  const canary = 'SOL-1364-MAP-CONTENT-WRITTEN-AFTER-EXPIRY';
  const locked = signal();
  const scoped = signal();
  let admitted = false;
  const received: string[] = [];
  const blocker = w.db.admin.transaction(async (query) => {
    await query('select id from public.records where business_id = $1 and id = $2 for update', [
      w.business,
      ticket.id,
    ]);
    locked.resolve();
    await scoped.promise;
    await query(
      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.1)
        from public.grants where business_id = $1 and id = $2`,
      [w.business, grant.id],
    );
    await query(
      `update public.records set data = jsonb_set(data, '{parent}', to_jsonb($3::text))
        where business_id = $1 and id = $2`,
      [w.business, ticket.id, other.id],
    );
    await query(
      `update public.records set data = jsonb_set(data, '{title}', to_jsonb($3::text))
        where business_id = $1 and id = $2`,
      [w.business, map.id, canary],
    );
  });
  await locked.promise;
  const observed = observedDatabase(
    async () => {},
    async (statement, parameters, rows) => {
      received.push(JSON.stringify(rows));
      if (
        statement.includes('select distinct e.scope_kind, e.scope_id') &&
        parameters?.[0] === 'task' &&
        parameters[1] === 'read'
      ) {
        admitted = rows.length > 0;
        scoped.resolve();
      }
    },
  );
  const [answer] = await Promise.all([
    executeRead(observed, w.business, reader.presented, { read: 'task.board', board: null }),
    blocker,
  ]);
  expect(admitted).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: map.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect({
    fetched: received.join('\n').includes(canary),
    returned: JSON.stringify(answer).includes(canary),
  }).toEqual({ fetched: false, returned: false });
}, 30_000);

it('a map retyped before board content is fetched grants no access to its former tickets', async () => {
  const map = await w.create(owner, { title: 'Retyped map' }, { taskType: 'map' });
  const canary = 'SOL-1364-FORMER-TICKET-PRIVATE-TITLE';
  const ticket = await w.create(owner, { title: canary }, { parentId: map.id });
  const reader = await w.member('Sol retype reader', ['read'], { kind: 'record', id: map.id });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');
  let retyped = false;
  const received: string[] = [];
  const observed = observedDatabase(
    async (statement) => {
      if (!retyped && statement.includes('r.txt_4 as title')) {
        retyped = true;
        must(
          await w.asOnSecond(owner, {
            command: 'task.set_type',
            recordId: map.id,
            expectedRevision: await w.revisionOf(map.id),
            taskType: 'task',
          }),
          'retype map',
        );
      }
    },
    async (_statement, _parameters, rows) => {
      received.push(JSON.stringify(rows));
    },
  );
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(retyped).toBe(true);
  expect('tasks' in answer).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect({
    fetched: received.join('\n').includes(canary),
    returned: JSON.stringify(answer).includes(canary),
  }).toEqual({ fetched: false, returned: false });
}, 30_000);

// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { gate } from '../support/lock-waits.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('sol1364expiry', 'sol1364expiry');
  owner = await w.decider('Sol expiry owner');
}, 180_000);
afterAll(async () => await w?.drop());

// eslint-disable-next-line max-lines-per-function -- one race, its schedule read top to bottom
it('a map grant expiring during the ticket lock wait fetches no later ticket content', async () => {
  const map = await w.create(owner, { title: 'Expiring map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Before expiry' }, { parentId: map.id });
  const reader = await w.member('Sol expiring reader', ['read'], { kind: 'record', id: map.id });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');
  const [grant] = await w.db.admin.execute<{ id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
     where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'read'
     returning id`,
    [w.business, reader.personId],
  );
  if (grant === undefined) throw new Error('reader grant missing');
  const canary = 'SOL-1364-CONTENT-WRITTEN-AFTER-MAP-GRANT-EXPIRED';
  const { promise: locked, release: lockReady } = gate();
  const { promise: scoped, release: scopeReady } = gate();
  const received: string[] = [];
  let grantedAtAdmission = false;
  const blocker = w.db.admin.transaction(async (query) => {
    await query('select id from public.records where business_id = $1 and id = $2 for update', [
      w.business,
      ticket.id,
    ]);
    lockReady();
    await scoped;
    await query(
      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.1)
       from public.grants where business_id = $1 and id = $2`,
      [w.business, grant.id],
    );
    await query(
      `update public.records set data = jsonb_set(data, '{title}', to_jsonb($3::text))
       where business_id = $1 and id = $2`,
      [w.business, ticket.id, canary],
    );
  });
  await locked;
  const observed: Database = {
    log: w.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await w.db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            if (
              statement.includes('select distinct e.scope_kind, e.scope_id') &&
              parameters?.[0] === 'task' &&
              parameters[1] === 'read'
            ) {
              grantedAtAdmission = rows.length > 0;
              scopeReady();
            }
            return rows;
          },
        };
        return await run(watched);
      }),
  };
  const reading = executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  const [answer] = await Promise.all([reading, blocker]);
  expect(grantedAtAdmission).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect({
    privateContentFetched: received.join('\n').includes(canary),
    privateContentReturned: JSON.stringify(answer).includes(canary),
  }).toEqual({ privateContentFetched: false, privateContentReturned: false });
}, 30_000);

// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { waitingOn } from '../support/lock-waits.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('mapinstant', 'mapinstant');
  owner = await w.decider('Map instant owner');
}, 180_000);
afterAll(async () => await w?.drop());

type After = (
  statement: string,
  parameters: readonly unknown[] | undefined,
  rows: readonly unknown[],
) => Promise<void>;

/** The app's database, with `after` run on every statement the read sends. */
function observedDatabase(after: After): Database {
  return {
    log: w.db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await w.db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          ...tx,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            await after(statement, parameters, rows);
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

async function scored(task: Made, impact: number): Promise<void> {
  must(
    await w.as(owner, {
      command: 'task.set_scores',
      recordId: task.id,
      expectedRevision: await w.revisionOf(task.id),
      fields: { impact, confidence: 10, ease: 10 },
    }),
    'score ticket',
  );
}

// A writer that holds a map and then waits on its ticket, as a close-out
// does, while `task.read` holds that ticket for its answer.
const WRITER = '/* map writer waits on its ticket */';

it('a map ticket rank counts its higher-scored sibling while a map writer waits on the ticket', async () => {
  const map = await w.create(owner, { title: 'Held map' }, { taskType: 'map' });
  const low = await w.create(owner, { title: 'Held low ticket' }, { parentId: map.id });
  const high = await w.create(owner, { title: 'Free high ticket' }, { parentId: map.id });
  await scored(low, 1);
  await scored(high, 10);
  const reader = await w.member('Held map reader', ['read'], { kind: 'record', id: map.id });
  const writerDb = connect(w.db.appUrl);
  let writer: Promise<unknown> | undefined;
  const observed = observedDatabase(async (statement) => {
    if (writer !== undefined || !statement.includes('for share of r')) return;
    writer = writerDb.withBusiness(w.business, async (tx) => {
      await tx.query(
        'select id from public.records where business_id = $1 and id = $2 for update',
        [w.business, map.id],
      );
      await tx.query(
        `${WRITER} select id from public.records where business_id = $1 and id = $2 for update`,
        [w.business, low.id],
      );
    });
    await waitingOn(w.db.admin, 'transactionid', WRITER);
  });
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.read',
    recordId: low.id,
  }).finally(async () => {
    await writer;
    await writerDb.close();
  });
  expect(writer).toBeDefined();
  if (!('task' in answer) || !('rank' in answer.task)) throw new Error('ticket read was refused');
  expect(answer.task.rank.number).toBe(2);
}, 30_000);

// eslint-disable-next-line max-lines-per-function -- one race, its schedule read top to bottom
it('a map grant lapsing after board admission reaches no map content', async () => {
  const mapTitle = 'MAP-INSTANT-MAP-TITLE-AFTER-LAPSE';
  const ticketTitle = 'MAP-INSTANT-TICKET-TITLE-AFTER-LAPSE';
  const map = await w.create(owner, { title: mapTitle }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: ticketTitle }, { parentId: map.id });
  const reader = await w.member('Lapsing map reader', ['read'], { kind: 'record', id: map.id });
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe('applied');
  const [grant] = await w.db.admin.execute<{ id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'read'
      returning id`,
    [w.business, reader.personId],
  );
  if (grant === undefined) throw new Error('reader grant missing');
  let admitted = false;
  const received: string[] = [];
  const observed = observedDatabase(async (statement, parameters, rows) => {
    received.push(JSON.stringify(rows));
    const admission =
      statement.includes('select distinct e.scope_kind, e.scope_id') &&
      parameters?.[0] === 'task' &&
      parameters[1] === 'read';
    if (admitted || !admission) return;
    admitted = rows.length > 0;
    must(
      await w.asOnSecond(owner, {
        command: 'task.reparent',
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        parentId: null,
      }),
      'move the ticket out of its map',
    );
    await w.db.admin.execute(
      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.1)
         from public.grants where business_id = $1 and id = $2`,
      [w.business, grant.id],
    );
    const [lapsed] = await w.db.admin.execute<{ lapsed: boolean }>(
      `select clock_timestamp() > expires_at as lapsed
         from public.grants where business_id = $1 and id = $2`,
      [w.business, grant.id],
    );
    expect(lapsed?.lapsed).toBe(true);
  });
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(admitted).toBe(true);
  expect({
    fetched: [mapTitle, ticketTitle].filter((title) => received.join('\n').includes(title)),
    returned: [mapTitle, ticketTitle].filter((title) => JSON.stringify(answer).includes(title)),
  }).toEqual({ fetched: [], returned: [] });
}, 30_000);

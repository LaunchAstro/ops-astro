// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one schedule and its seeded details, read top to bottom */
// A reader whose only task read is a record grant on map M reads the board
// with no board. Once the board rows statement has answered, a second
// connection takes ticket T out of M's reach (a move to another map of the
// same client, or M retyped to a plain task) and commits, then writes later
// details on T. No later board statement may fetch those details: the grant
// is judged inside each statement, so a filter on the answer is not enough.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
// The board rows statement (`readBoardRows` in reads/tasks.ts) is the one task.board
// statement that reads the shared task SELECT, whose last column is this.
const BOARD_ROWS = 'r.uuid_7 is not null as client_set';

let w: WayfinderWorld;
let owner: Decider;
let client: string;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('p10leftmap', 'p10leftmap');
  owner = await w.decider('Left map owner');
  await w.grant(owner, 'assign');
  await w.grant(owner, 'share');
  await w.db.app.withBusiness(w.business, async (tx) => {
    for (const collection of ['tag', 'time']) {
      // eslint-disable-next-line no-await-in-loop -- one grant after another on one connection
      await grantTo(tx, owner, 'write', { kind: 'business', id: null }, false, collection);
    }
  });
  client = randomUUID();
  await addClient(w.db.app, w.business, client, owner);
}, 180_000);
afterAll(async () => await w?.drop());

function observedDatabase(
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
            const rows = await tx.query<Row>(statement, parameters);
            await after(statement, parameters, rows);
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

const second = async (body: Readonly<Record<string, unknown>>, what: string) =>
  must(await w.asOnSecond(owner, body), what);

async function scopedMap(title: string): Promise<string> {
  const map = await w.create(owner, { title }, { taskType: 'map' });
  must(
    await w.as(owner, {
      command: 'map.scope',
      recordId: map.id,
      expectedRevision: await w.revisionOf(map.id),
      client,
    }),
    'scope map',
  );
  return map.id;
}

/** A client named the canary, which the reader reaches by a client grant (no task read). */
async function canaryClient(reader: Member, canary: string): Promise<string> {
  const id = randomUUID();
  await w.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id) values ($1, $2, $3, $4)`,
    [w.business, id, canary, owner.actorId],
  );
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'party', id }, false, 'client');
  });
  return id;
}

/** Every later detail the board reads of a task, each carrying the canary where it has text. */
async function writeLaterDetails(
  ticket: string,
  reader: Member,
  canary: string,
  canaryClientId: string,
): Promise<void> {
  const tag = detailOf(await w.asOnSecond(owner, { command: 'tag.create', name: canary }));
  await second({ command: 'task.add_tag', recordId: ticket, tagId: tag['tagId'] }, 'add tag');
  await second(
    { command: 'time.log', taskId: ticket, duration: '45m', note: canary },
    'log finished time',
  );
  const agent = detailOf(await w.asOnSecond(owner, { command: 'agent.create', name: canary }));
  await second(
    {
      command: 'task.assign',
      recordId: ticket,
      expectedRevision: await w.revisionOf(ticket),
      fields: { agent: agent['agentId'] },
    },
    'assign agent',
  );
  await second(
    {
      command: 'task.propose',
      recordId: ticket,
      expectedRevision: await w.revisionOf(ticket),
      purpose: 'left_map',
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: canary },
      step: { kind: 'compose', payload: {} },
    },
    'propose a gate',
  );
  const comment = detailOf(
    await w.asOnSecond(owner, {
      command: 'task.comment',
      recordId: ticket,
      expectedRevision: await w.revisionOf(ticket),
      body: canary,
      audience: 'internal',
    }),
  );
  // No command raises an inbox item for a reader who no longer reaches the task.
  await w.db.admin.execute(
    `insert into public.inbox_items
       (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id,
        owed, work_state)
     select $1, gen_random_uuid(), $2, $3, reason, 'record', $4, true, 'open'
       from unnest(array['client_comment', 'mention']) as reason`,
    [w.business, reader.personId, ticket, comment['commentId']],
  );
  // A ticket carries its map's client and no command changes it alone.
  await w.db.admin.execute(
    `update public.records
        set data = jsonb_set(data, '{client}', to_jsonb($3::text)), uuid_7 = $3::uuid
      where business_id = $1 and id = $2`,
    [w.business, ticket, canaryClientId],
  );
}

interface ServedRow {
  readonly id: string;
  readonly todo?: { readonly tags: readonly unknown[] };
  readonly actualMinutes: number;
  readonly agent: unknown;
  readonly waitReason: unknown;
  readonly comments: unknown;
  readonly client: unknown;
}

async function leaveAfterRows(
  how: 'move' | 'retype',
  canary: string,
): Promise<{ readonly fetched: boolean; readonly returned: boolean; readonly row: unknown }> {
  const map = await scopedMap('Granted map');
  const other = await scopedMap('Ungranted map');
  const ticket = (await w.create(owner, { title: 'Leaving ticket' }, { parentId: map })).id;
  const reader = await w.member(`Left map reader ${how}`, ['read'], { kind: 'record', id: map });
  const canaryClientId = await canaryClient(reader, canary);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket }))).toBe('applied');
  let left = false;
  const received: string[] = [];
  const observed = observedDatabase(async (statement, _parameters, rows) => {
    received.push(JSON.stringify(rows));
    if (left || !statement.includes(BOARD_ROWS)) return;
    left = true;
    await second(
      how === 'move'
        ? {
            command: 'task.reparent',
            recordId: ticket,
            expectedRevision: await w.revisionOf(ticket),
            parentId: other,
          }
        : {
            command: 'task.set_type',
            recordId: map,
            expectedRevision: await w.revisionOf(map),
            taskType: 'task',
          },
      how,
    );
    await writeLaterDetails(ticket, reader, canary, canaryClientId);
  });
  const answer = await executeRead(observed, w.business, reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(left).toBe(true);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  if (!('tasks' in answer)) throw new Error(`task.board refused: ${JSON.stringify(answer)}`);
  const served = (answer.tasks as unknown as readonly ServedRow[]).find((row) => row.id === ticket);
  return {
    fetched: received.join('\n').includes(canary),
    returned: JSON.stringify(answer).includes(canary),
    row:
      served === undefined
        ? 'not served'
        : {
            tags: served.todo?.tags,
            actualMinutes: served.actualMinutes,
            agent: served.agent,
            waitReason: served.waitReason,
            comments: served.comments,
            client: served.client,
          },
  };
}

const NOTHING_LATER = {
  fetched: false,
  returned: false,
  row: {
    tags: [],
    actualMinutes: 0,
    agent: null,
    waitReason: null,
    comments: { client: 0, mentions: 0, latest: null },
    client: null,
  },
};

it('a ticket moved out of its granted map after the board rows are read shows none of its later tags, agents, time, gates, comments or client', async () => {
  expect(await leaveAfterRows('move', 'P10-MOVED-TICKET-LATER-DETAIL')).toEqual(NOTHING_LATER);
}, 60_000);

it('a ticket whose granted map is retyped to a plain task after the board rows are read shows none of its later tags, agents, time, gates, comments or client', async () => {
  expect(await leaveAfterRows('retype', 'P10-RETYPED-MAP-LATER-DETAIL')).toEqual(NOTHING_LATER);
}, 60_000);

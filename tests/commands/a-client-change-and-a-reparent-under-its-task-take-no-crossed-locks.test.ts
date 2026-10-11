// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.set_party` on an empty task T, which sits on a project P with no
// client, and `task.reparent` of P under T, at once. The reparent holds P and
// then asks for T; the client change holds T and must not then wait on P, or
// the two lock T and P in opposite orders and Postgres ends one as a
// deadlock. Both records and both writes are made by real commands: the
// reparent is paused after it holds P, the client change runs, and the
// database's deadlock counter must not move. One write lands and the other is
// refused for the client it no longer shares.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { clientHere } from '../reads/client-rows.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-client-change-and-a-reparent-under-its-task-take-no-crossed-locks: DATABASE_URL is unset, so nothing ran.',
  );
}

let db: FreshDatabase;
let business: string;
let owner: Member;
let second: Database;

type Request = Parameters<typeof executeCommand>[4];
const send = (on: Database, body: Record<string, unknown>) =>
  executeCommand(on, business, owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as Request);

async function made(body: Record<string, unknown>) {
  const answer = await send(db.app, {
    command: 'task.create',
    fields: { title: 'Empty' },
    ...body,
  });
  if (isCommandRefusal(answer) || answer.recordId === null) throw new Error('setup create refused');
  return { recordId: answer.recordId, revision: answer.revision };
}

async function deadlocks() {
  await db.admin.execute('select pg_stat_clear_snapshot()');
  const rows = await db.admin.execute<{ n: string }>(
    'select deadlocks::text as n from pg_stat_database where datname = current_database()',
  );
  return Number(rows[0]?.n);
}

/** A promise and the function that settles it. */
function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settled: (() => void) | undefined;
  const promise = new Promise<void>((settle) => {
    settled = settle;
  });
  return { promise, resolve: () => settled?.() };
}

/** `db.app`, with one pause after the reparent's own row lock on `target`. */
function pausedAfterLocking(target: string, held: () => void, resume: Promise<void>): Database {
  let paused = false;
  return {
    ...db.app,
    async withBusiness(where, run) {
      return await db.app.withBusiness(
        where,
        async (tx) =>
          await run({
            ...tx,
            async query<Row>(sql: string, parameters: readonly unknown[] = []) {
              const rows = await tx.query<Row>(sql, parameters);
              if (
                !paused &&
                parameters[2] === target &&
                sql.includes('revision::text as revision') &&
                sql.includes('for update')
              ) {
                paused = true;
                held();
                await resume;
              }
              return rows;
            },
          }),
      );
    },
  };
}

/** Until a session waits on a `for share` row lock, or five seconds pass. */
async function untilShareWaits(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await db.admin.execute<{ waiting: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%for share%') as waiting`,
    );
    if (rows[0]?.waiting === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await sleep(20);
  }
}

/** A client change on the task while a reparent of its project under it holds the project. */
async function raceTheTwoWrites(): Promise<void> {
  const project = await made({});
  const task = await made({ board: project.recordId });
  const client = await clientHere(db.admin, business, randomUUID());
  const held = signal();
  const resume = signal();
  const before = await deadlocks();

  const reparent = send(pausedAfterLocking(project.recordId, held.resolve, resume.promise), {
    command: 'task.reparent',
    recordId: project.recordId,
    expectedRevision: project.revision,
    parentId: task.recordId,
  });
  await held.promise;
  const party = send(second, {
    command: 'task.set_party',
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { client },
  });
  try {
    await untilShareWaits();
  } finally {
    resume.resolve();
  }
  // The envelope retries one deadlock, so the answers alone cannot show none happened.
  const answers = await Promise.all([reparent, party]);
  expect(answers.filter((answer) => !isCommandRefusal(answer))).toHaveLength(1);
  const refusal = answers.find((answer) => isCommandRefusal(answer));
  expect(['CLIENT_LOCKED', 'PLACEMENT_IS_DERIVED']).toContain(refusal?.code);

  // Each session publishes its statistics before the counter is read.
  await db.app.withBusiness(business, (tx) => tx.query('select pg_stat_force_next_flush()'));
  await second.withBusiness(business, (tx) => tx.query('select pg_stat_force_next_flush()'));
  await sleep(600);
  expect((await deadlocks()) - before).toBe(0);
}

describe.skipIf(serverUrl === undefined)('a client change beside a reparent under its task', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'partyreparent' });
    second = connect(db.appUrl);
    business = await insertBusiness(db.app, 'party-reparent-race');
    await installSpine(db.app, business);
    owner = await enrol(db.app, business, 'owner');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, owner, action);
      }
    });
  }, 180_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  it(
    'takes the task and its project in one order, so neither write ends in a deadlock',
    raceTheTwoWrites,
    20_000,
  );
});

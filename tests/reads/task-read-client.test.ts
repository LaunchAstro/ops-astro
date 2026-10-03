// SPDX-License-Identifier: AGPL-3.0-only
//
// SL12-19-F2: the task detail carries its client. `task.read` answers with the
// record's `client` slot (`uuid_7`) as `clientId`, null on an internal task, so
// the Agent pane's ask to the drawer names the client whose data the plan would
// carry (AW-04). Anyone who reads the task already reaches its client, so the
// field widens nothing; each crossing below stays the answer it was. Business
// to business, client to client, person to person, over a real database.
//
// SL12-24-AW04, ported onto main: main sends the task's client as `client`,
// and only where the reader's grants reach that client (CS-4.12), so this
// file's two cases that read a `clientId` (the client id for a client task,
// and a record-scoped grant reading client A) are left out; main proves that
// rule in task-client-facts.test.ts and task-client-facts-isolation.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createTask } from '../tasks/fixture.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('reads/task-read-client: DATABASE_URL is unset, so nothing below ran.');
}

type Answer = Readonly<Record<string, unknown>>;

const LINK = `update public.records set data = data || jsonb_build_object('client', $2::text)
               where business_id = $1 and id = $3`;

interface World {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly clientA: string;
  readonly clientB: string;
  /** Ada reads the whole of alpha, Cleo client A's task only, Bruno the whole of bravo. */
  readonly ada: Member;
  readonly cleo: Member;
  readonly bruno: Member;
  /** Client A's person outside the business, on the one task Ada shares. */
  readonly outsider: Member;
  readonly tasks: { a: string; b: string; internal: string; bravo: string };
}

/** Two businesses; in alpha one task per client and one internal, in bravo one client task. */
async function openWorld(): Promise<World> {
  const db = await createFreshDatabase({ part: 'taskclient' });
  const alpha = (await insertBusiness(db.app, 'alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'bravo')) as BusinessId;
  const alphaSpine = await installSpine(db.app, alpha);
  const bravoSpine = await installSpine(db.app, bravo);
  const [clientA, clientB] = [randomUUID(), randomUUID()];
  const ada = await enrol(db.app, alpha, 'ada');
  const cleo = await enrol(db.app, alpha, 'cleo');
  const bruno = await enrol(db.app, bravo, 'bruno');
  const tasks = { a: '', b: '', internal: '', bravo: '' };
  await db.app.withBusiness(alpha, async (tx) => {
    tasks.a = await createTask(tx, alphaSpine, { title: 'client A work', parentId: null });
    tasks.b = await createTask(tx, alphaSpine, { title: 'client B work', parentId: null });
    tasks.internal = await createTask(tx, alphaSpine, { title: 'our work', parentId: null });
    await tx.query(LINK, [tx.businessId, clientA, tasks.a]);
    await tx.query(LINK, [tx.businessId, clientB, tasks.b]);
    await grantTo(tx, ada, 'read');
    await grantTo(tx, ada, 'share');
    // `task.read` matches a grant on the record or the business, so a member
    // kept to one client's work holds the read on that client's task.
    await grantTo(tx, cleo, 'read', { kind: 'record', id: tasks.a });
  });
  await db.app.withBusiness(bravo, async (tx) => {
    tasks.bravo = await createTask(tx, bravoSpine, { title: 'bravo work', parentId: null });
    await tx.query(LINK, [tx.businessId, randomUUID(), tasks.bravo]);
    await grantTo(tx, bruno, 'read');
  });
  const outsider = await shareWithClient(db.app, alpha, ada, tasks.a);
  return { db, alpha, bravo, clientA, clientB, ada, cleo, bruno, outsider, tasks };
}

describe.skipIf(serverUrl === undefined)('task.read carries the task’s client', () => {
  let w: World;

  const read = async (business: BusinessId, who: Member, recordId: string): Promise<Answer> =>
    (await executeRead(w.db.app, business, who.presented, {
      read: 'task.read',
      recordId,
    } as never)) as unknown as Answer;

  beforeAll(async () => {
    w = await openWorld();
  }, 180_000);

  afterAll(async () => {
    await w?.db.drop();
  });

  it('business to business: another business’s task stays NOT_FOUND, client or none', async () => {
    expect((await read(w.alpha, w.ada, w.tasks.bravo))['code']).toBe('NOT_FOUND');
    expect((await read(w.bravo, w.bruno, w.tasks.a))['code']).toBe('NOT_FOUND');
    expect((await read(w.bravo, w.bruno, w.tasks.internal))['code']).toBe('NOT_FOUND');
  });

  it('person to person: the client outside the business sees its shared view, no client id, and the other client’s task NOT_FOUND', async () => {
    const own = await read(w.alpha, w.outsider, w.tasks.a);
    expect(own['sharedTask']).toBeDefined();
    expect(JSON.stringify(own)).not.toContain(w.clientA);
    expect((await read(w.alpha, w.outsider, w.tasks.b))['code']).toBe('NOT_FOUND');
  });
});

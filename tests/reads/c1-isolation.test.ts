// SPDX-License-Identifier: AGPL-3.0-only
//
// C1 isolation: search shows no foreign title, id or count, across the three
// crossings. Another business and another client in the same business run
// through `task.search` on a fresh database, with a canary word planted only
// on the other side; another person, an agent under a live delegation, runs
// through the real HTTP route of the role-case harness. Every answer body is
// read whole, refusals included.

// Sequential on purpose: each query is one call under the one live delegation.
// oxlint-disable no-await-in-loop

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const THEIR_BUSINESS_WORD = 'marmoreal';
const THEIR_CLIENT_WORD = 'nacreous';

/** Two businesses, one of them with two clients' tasks, and a canary word on each far side. */
interface World {
  readonly alpha: string;
  /** Reads every task in alpha. */
  readonly mia: Member;
  /** Holds task:read on the first client's task only. */
  readonly ann: Member;
  /** Reads every task in beta. */
  readonly bea: Member;
  readonly theirBusinessTask: string;
  readonly theirClientTask: string;
}

async function create(
  db: FreshDatabase,
  business: string,
  who: Member,
  title: string,
): Promise<string> {
  const created = await executeCommand(db.app, business, who.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  } as never);
  if (isCommandRefusal(created) || created.recordId === null) {
    throw new Error(`task.create: ${JSON.stringify(created)}`);
  }
  return created.recordId;
}

const search = async (db: FreshDatabase, who: Member, query: string, business: string) =>
  JSON.stringify(
    await executeRead(db.app, business, who.presented, {
      read: 'task.search',
      query,
    } as ReadRequest),
  );

async function seed(db: FreshDatabase): Promise<World> {
  const alpha = await insertBusiness(db.app, 'alpha');
  const beta = await insertBusiness(db.app, 'beta');
  await installSpine(db.app, alpha);
  await installSpine(db.app, beta);
  const mia = await enrol(db.app, alpha, 'mia');
  const ann = await enrol(db.app, alpha, 'ann');
  const bea = await enrol(db.app, beta, 'bea');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, mia, 'read');
    await grantTo(tx, mia, 'write');
  });
  await db.app.withBusiness(beta, async (tx) => {
    await grantTo(tx, bea, 'read');
    await grantTo(tx, bea, 'write');
  });
  const ownClientTask = await create(db, alpha, mia, 'Acme brochure');
  const theirClientTask = await create(db, alpha, mia, `Boreal ${THEIR_CLIENT_WORD} invoice`);
  const theirBusinessTask = await create(db, beta, bea, `Beta ${THEIR_BUSINESS_WORD} copy`);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ann, 'read', { kind: 'record', id: ownClientTask });
  });
  return { alpha, mia, ann, bea, theirBusinessTask, theirClientTask };
}

describe.skipIf(serverUrl === undefined)('C1 isolation', () => {
  let db: FreshDatabase;
  let world: World;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'c1iso' });
    world = await seed(db);
  }, 120_000);

  afterAll(async () => await db?.drop());

  it('another business: a whole-business reader finds nothing of the other business', async () => {
    const { alpha, mia, bea, theirBusinessTask } = world;
    const body = await search(db, mia, THEIR_BUSINESS_WORD, alpha);
    expect(JSON.parse(body)).toEqual({ ok: true, hits: [] });
    expect(body).not.toContain(theirBusinessTask);
    expect(body).not.toContain('Beta');
    // And the other way: beta's reader, asking under alpha, is refused naming nothing.
    const crossed = await search(db, bea, 'Acme', alpha);
    expect(crossed).not.toContain('Acme');
    expect(crossed).not.toMatch(/"hits"/u);
  });

  it('another client in the same business: one client’s grant finds nothing of the other, not a count', async () => {
    const { alpha, ann, theirClientTask } = world;
    const body = await search(db, ann, THEIR_CLIENT_WORD, alpha);
    expect(JSON.parse(body)).toEqual({ ok: true, hits: [] });
    expect(body).not.toContain(theirClientTask);
    expect(body).not.toContain('Boreal');
    expect(await search(db, ann, 'brochure', alpha)).toContain('Acme brochure');
  });
});

describe.skipIf(serverUrl === undefined)('C1 isolation, over the real HTTP route', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness('c1isoagent');
  }, 120_000);

  afterAll(async () => await harness?.close());

  it('another person under a live delegation: the agent is refused, naming no title, id or count', async () => {
    const { subject, sibling, decided } = await harness.approvedReservation();
    const detail = decided.body['detail'] as Record<string, unknown>;
    const picked = await harness.asAgent('task.pickup', {
      reservationId: String(detail['reservationId']),
    });
    const credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
    for (const query of ['sibling', 'reach', 'agent']) {
      const answer = await harness.asAgent('task.search', { query }, credential);
      const body = JSON.stringify(answer.body);
      expect(answer.body['code'], query).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(body, query).not.toContain(sibling.id);
      expect(body, query).not.toContain(subject.id);
      expect(body, query).not.toMatch(/"hits"|sibling the agent/u);
    }
  });
});

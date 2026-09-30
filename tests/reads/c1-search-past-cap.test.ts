// SPDX-License-Identifier: AGPL-3.0-only
//
// C1 past the cap: a server caller (the ledger's search, MP-8-4) may ask
// `searchTasks` for more than the twenty hits the ⌘K read answers, up to a
// bound, and is told when matches lie past what it asked for. The scope is
// still a predicate of the one statement, so a larger page reads no more of
// another client, business or person than a small one; the `task.search`
// read and its operands stay as they were.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { withSession } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { searchTasks } from '../../packages/core-commands/src/reads/search.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORD = 'plenary';
const CANARY = 'vermilion';

let db: FreshDatabase;
let alpha: string;
let beta: string;
/** Reads every task in alpha. */
let mia: Member;
/** Holds task:read on the first client's 25 tasks only. */
let ann: Member;
/** Reads every task in beta. */
let bea: Member;
const annTasks: string[] = [];
const otherClientTasks: string[] = [];
const betaTasks: string[] = [];

const create = async (business: string, who: Member, title: string): Promise<string> => {
  const created = await executeCommand(db.app, business, who.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  } as never);
  if (isCommandRefusal(created) || created.recordId === null) {
    throw new Error(`task.create: ${JSON.stringify(created)}`);
  }
  return created.recordId;
};

/** `count` calls of `step`, one after another, their answers in order. */
async function inTurn<T>(count: number, step: (n: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  await Array.from({ length: count }, (_, n) => n).reduce(async (before, n) => {
    await before;
    out.push(await step(n));
  }, Promise.resolve());
  return out;
}

/** `searchTasks` as a server caller runs it, inside the caller's own session. */
const serverSearch = async (who: Member, limit?: unknown, business = alpha) =>
  await withSession(db.app, business, who.presented, async (tx, session) => {
    const spine = await readTaskSpine(tx);
    return await searchTasks(tx, session, {
      taskTypeId: spine.taskTypeId,
      query: WORD,
      ...(limit === undefined ? {} : { limit: limit as number }),
    });
  });

const hitsOf = (answer: unknown): readonly string[] => {
  const hits = (answer as { readonly hits?: readonly { readonly id: string }[] }).hits;
  if (hits === undefined) throw new Error(`no hits: ${JSON.stringify(answer)}`);
  return hits.map((hit) => hit.id);
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c1cap' });
  alpha = await insertBusiness(db.app, 'alpha');
  beta = await insertBusiness(db.app, 'beta');
  await installSpine(db.app, alpha);
  await installSpine(db.app, beta);
  mia = await enrol(db.app, alpha, 'mia');
  ann = await enrol(db.app, alpha, 'ann');
  bea = await enrol(db.app, beta, 'bea');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, mia, 'read');
    await grantTo(tx, mia, 'write');
  });
  await db.app.withBusiness(beta, async (tx) => {
    await grantTo(tx, bea, 'read');
    await grantTo(tx, bea, 'write');
  });
  annTasks.push(...(await inTurn(25, (n) => create(alpha, mia, `Acme ${WORD} ${n}`))));
  otherClientTasks.push(
    ...(await inTurn(5, (n) => create(alpha, mia, `Boreal ${WORD} ${CANARY} ${n}`))),
  );
  betaTasks.push(...(await inTurn(3, (n) => create(beta, bea, `Beta ${WORD} ${CANARY} ${n}`))));
  await db.app.withBusiness(alpha, async (tx) => {
    await inTurn(annTasks.length, (n) =>
      grantTo(tx, ann, 'read', { kind: 'record', id: annTasks[n] as string }),
    );
  });
}, 180_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C1 search past the cap', () => {
  it('C1 search past the cap: a server caller with a limit reads past twenty, and is told when there is more', async () => {
    const all = await serverSearch(mia, 100);
    expect(hitsOf(all)).toHaveLength(30);
    expect(all).not.toHaveProperty('more', true);
    const some = await serverSearch(mia, 25);
    expect(hitsOf(some)).toHaveLength(25);
    expect(some).toHaveProperty('more', true);
    // No limit: the twenty the read has always answered, and no `more`.
    const plain = await serverSearch(mia);
    expect(hitsOf(plain)).toHaveLength(20);
    expect(plain).not.toHaveProperty('more');
  });

  it('C1 search past the cap: the task.search read is unchanged at twenty and never honours a limit', async () => {
    const plain = await executeRead(db.app, alpha, mia.presented, {
      read: 'task.search',
      query: WORD,
    } as ReadRequest);
    expect(hitsOf(plain)).toHaveLength(20);
    expect(plain).not.toHaveProperty('more');
    // The read's operands are the query alone: a limit in its body is not one.
    const asked = await executeRead(db.app, alpha, mia.presented, {
      read: 'task.search',
      query: WORD,
      limit: 100,
    } as unknown as ReadRequest);
    expect(hitsOf(asked)).toHaveLength(20);
    expect(asked).not.toHaveProperty('more');
  });

  it('C1 search past the cap: another client’s tasks never enter the answer, not by id, title or count', async () => {
    const answer = await serverSearch(ann, 500);
    expect(hitsOf(answer).toSorted()).toEqual(annTasks.toSorted());
    // Five foreign matches lie past nothing: `more` is about her scope alone.
    expect(answer).not.toHaveProperty('more', true);
    const body = JSON.stringify(answer);
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain('Boreal');
    for (const id of otherClientTasks) expect(body).not.toContain(id);
    // A limit below her own count says more, and still names none of theirs.
    const small = await serverSearch(ann, 24);
    expect(small).toHaveProperty('more', true);
    for (const id of otherClientTasks) expect(JSON.stringify(small)).not.toContain(id);
  });

  it('C1 search past the cap: another business never enters it, and a stranger to the business is refused', async () => {
    const answer = JSON.stringify(await serverSearch(mia, 500));
    for (const id of betaTasks) expect(answer).not.toContain(id);
    expect(answer).not.toContain('Beta');
    const crossed = await serverSearch(bea, 500, alpha);
    expect(isCommandRefusal(crossed) ? crossed.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(crossed)).not.toMatch(/"hits"|Acme|Boreal/u);
  });

  it('C1 search past the cap: a limit that is not a whole number from 1 to 500 is refused naming limit, with nothing read', async () => {
    const limits = [0, -1, 501, 2.5, Number.NaN, '50', null];
    const answers = await inTurn(limits.length, (n) => serverSearch(mia, limits[n]));
    answers.forEach((answer, n) => {
      const said = String(limits[n]);
      expect(isCommandRefusal(answer) ? answer.code : 'answered', said).toBe('FIELD_VALUE_INVALID');
      expect(isCommandRefusal(answer) ? answer.names : [], said).toEqual(['limit']);
      expect(JSON.stringify(answer), said).not.toMatch(/"hits"|Acme|Boreal/u);
    });
  });
});

describe.skipIf(serverUrl === undefined)('C1 search past the cap, over the real HTTP route', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness('c1capagent');
  }, 120_000);

  afterAll(async () => await harness?.close());

  it('C1 search past the cap: an agent under a live delegation sending a limit is refused, naming no title, id or count', async () => {
    const { subject, sibling, decided } = await harness.approvedReservation();
    const detail = decided.body['detail'] as Record<string, unknown>;
    const picked = await harness.asAgent('task.pickup', {
      reservationId: String(detail['reservationId']),
    });
    const credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
    const answer = await harness.asAgent(
      'task.search',
      { query: 'sibling', limit: 500 },
      credential,
    );
    const body = JSON.stringify(answer.body);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(['DELEGATION_EXCLUDES_OPERATION', 'COMMAND_BODY_INVALID']).toContain(
      answer.body['code'],
    );
    expect(body).not.toContain(sibling.id);
    expect(body).not.toContain(subject.id);
    expect(body).not.toMatch(/"hits"|"more"/u);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-6 isolation` (ticket S0-6, the Vercel re-plan, section 3): the deployed
// app is a new path to the records, so the three crossings go through it, the
// Vercel function entry on its own host with the runtime and lookup logins
// only. Two businesses; two clients of one business, one record grant each;
// and an agent working under a person's live delegation. Each own read is
// answered, each crossing is refused with its status, and no refusal names
// the other side's record or title. The session cookie's half (one tab cannot
// read another person's token) is `session-cookie-binding.test.ts`.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { serveTestKeySet, type ServedKeySet } from '../support/sign-in.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { authorised, ISSUER, tokenFor, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const HOST = 'ops.example.test';
const KEY_ID = 'test/s0-6-isolation@1';
const SCOPE_KEY = randomBytes(32).toString('hex');
const BETA = 'beta';

interface World {
  readonly c: Controls;
  readonly keySet: ServedKeySet;
  readonly lookup: { readonly url: string; readonly name: string };
  readonly handle: (request: Request) => Promise<Response>;
  readonly beta: Member;
  readonly clientX: Member;
  readonly clientY: Member;
  /** Record ids and titles: X's and Y's tasks, beta's task, the delegated task. */
  readonly tasks: Readonly<Record<'x' | 'y' | 'b' | 'd', string>>;
  readonly credential: string;
}

let world: World | undefined;
const built = (): World => world as World;

const TITLES = { x: 'client X private', y: 'client Y private', b: 'beta private', d: 'delegated' };

/** A POST through the function entry, on its own host. */
async function call(
  path: string,
  body: Readonly<Record<string, unknown>>,
  headers: Record<string, string>,
): Promise<Answer> {
  const response = await built().handle(
    new Request(`https://${HOST}${path}`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

const asPerson = async (who: Member, recordId: string, business = 'alpha'): Promise<Answer> =>
  await call(
    `/api/b/${business}/task/read`,
    { recordId },
    authorised(await tokenFor(who.presented.subject)),
  );

const asAgent = async (recordId: string): Promise<Answer> =>
  await call(
    '/api/a/b/alpha/task/read',
    { recordId },
    {
      ...authorised(await tokenFor(built().c.fixture.agent.subject)),
      'x-agent-delegation': built().credential,
    },
  );

/** Refused with `status` and `code`, naming neither the record asked for nor its title. */
function refused(answer: Answer, status: number, code: string, task: keyof typeof TITLES): void {
  expect([answer.status, answer.body['code']], JSON.stringify(answer.body)).toStrictEqual([
    status,
    code,
  ]);
  const said = JSON.stringify(answer.body);
  expect(said).not.toContain(TITLES[task]);
  expect(said.replace(`"recordId":"${built().tasks[task]}"`, '')).not.toContain(
    built().tasks[task],
  );
}

async function answered(answer: Promise<Answer>, task: keyof typeof TITLES): Promise<void> {
  const own = await answer;
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect(JSON.stringify(own.body)).toContain(TITLES[task]);
}

/** Business beta: its own member and its own task, made through beta's own path. */
async function betaTask(c: Controls): Promise<{ readonly beta: Member; readonly b: string }> {
  const { db } = c.fixture;
  const betaId = await insertBusiness(db.app, BETA);
  await installSpine(db.app, betaId);
  const beta = await enrol(db.app, betaId, 'beta-member');
  await db.app.withBusiness(betaId, async (tx) => {
    await grantTo(tx, beta, 'read');
    await grantTo(tx, beta, 'write');
  });
  const made = await c.api.fetch(
    new Request(`http://api.test/api/b/${BETA}/task/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authorised(await tokenFor(beta.presented.subject)),
      },
      body: JSON.stringify({ operationId: randomUUID(), fields: { title: TITLES.b } }),
    }),
  );
  return { beta, b: String(((await made.json()) as Record<string, unknown>)['recordId']) };
}

async function build(): Promise<World> {
  const c = await createControls('s06iso');
  const { db, business } = c.fixture;
  const x = await c.createTask(TITLES.x);
  const y = await c.createTask(TITLES.y);
  const d = await c.createTask(TITLES.d);
  const clientX = await enrol(db.app, business, 'client-x');
  const clientY = await enrol(db.app, business, 'client-y');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, clientX, 'read', { kind: 'record', id: x.id });
    await grantTo(tx, clientY, 'read', { kind: 'record', id: y.id });
  });
  const { beta, b } = await betaTask(c);
  const picked = await c.pickup(await c.approve(await c.propose(d.id, d.revision)));
  const keySet = await serveTestKeySet();
  const lookup = await loginIn(db, 'ops_astro_lookup', 'si');
  const handle = createFunctionHandler({
    ...c.fixture.environment,
    DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
    DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
    DATABASE_URL: db.appUrl,
    DATABASE_LOOKUP_URL: lookup.url,
    GOTRUE_URL: ISSUER,
    SUPABASE_KEY_SET_URL: keySet.url,
    SERVED_HOST: HOST,
    OPS_ENVIRONMENT: 'staging',
    ALERT_SCOPE_KEY: SCOPE_KEY,
    RECOVERY_BUSINESS_KEYS: 'none',
  });
  return {
    c,
    keySet,
    lookup,
    handle,
    beta,
    clientX,
    clientY,
    tasks: { x: x.id, y: y.id, b, d: String(picked['taskId']) },
    credential: String(picked['credential']),
  };
}

describe.skipIf(serverUrl === undefined)('S0-6 isolation', () => {
  beforeAll(async () => {
    world = await build();
  }, 120_000);

  afterAll(async () => {
    await world?.keySet.close();
    await world?.c.drop();
    if (world === undefined) return;
    const cleanup = new Client(serverUrl ?? '');
    await cleanup.query(`drop role if exists "${world.lookup.name}"`).finally(() => cleanup.end());
  });

  it('business to business: each business reads its own task and not the other’s', async () => {
    const { c, beta, tasks } = built();
    await answered(asPerson(beta, tasks.b, BETA), 'b');
    refused(await asPerson(beta, tasks.x, BETA), 404, 'NOT_FOUND', 'x');
    refused(await asPerson(c.manager, tasks.b), 404, 'NOT_FOUND', 'b');
    refused(await asPerson(c.manager, tasks.b, BETA), 403, 'AUTH_NO_MEMBERSHIP', 'b');
  });

  it('client to client: one record grant each, the other client’s task refused', async () => {
    const { clientX, clientY, tasks } = built();
    await answered(asPerson(clientX, tasks.x), 'x');
    await answered(asPerson(clientY, tasks.y), 'y');
    refused(await asPerson(clientX, tasks.y), 403, 'SCOPE_NOT_GRANTED', 'y');
    refused(await asPerson(clientY, tasks.x), 403, 'SCOPE_NOT_GRANTED', 'x');
  });

  it('person to person: an agent under a live delegation reads its task and no other', async () => {
    const { tasks } = built();
    await answered(asAgent(tasks.d), 'd');
    refused(await asAgent(tasks.y), 403, 'DELEGATION_OUT_OF_PURPOSE', 'y');
    refused(await asAgent(tasks.b), 403, 'DELEGATION_OUT_OF_PURPOSE', 'b');
  });

  realOutboxCase();
});

function realOutboxCase() {
  it('keeps real business, client and delegate crossing details out of outbox rows', async () => {
    const { c, tasks, clientX, clientY } = built();
    const rows = await vi.waitFor(async () => {
      const found = await c.fixture.db.admin.execute<{ kind: string; scope: string; event: unknown }>(
        'select kind, scope, event from ops.api_events',
      );
      expect(found.length).toBeGreaterThanOrEqual(3);
      return found;
    });
    const serialised = JSON.stringify(rows);
    for (const secret of [
      tasks.x,
      tasks.y,
      tasks.b,
      tasks.d,
      clientX.presented.subject,
      clientY.presented.subject,
      c.fixture.agent.subject,
      ...Object.values(TITLES),
    ]) {
      expect(serialised.includes(secret), 'crossing detail in outbox').toBe(false);
    }
    expect(new Set(rows.map((row) => row.scope)).size).toBeGreaterThan(1);
  });
}

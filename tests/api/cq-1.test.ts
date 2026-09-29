// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-1: sign-in claims, the 1 MiB body limit, isolation, the canary and hono's audit.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { authorised, createApiFixture, tokenFor, type ApiFixture } from './fixture.ts';
import { ISSUER } from './fixture.ts';
import { signBearer, signForged, testSignIn } from '../support/sign-in.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertActor, insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const file = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const MIB = 1_048_576;
const [CREATE, BOARD, READ] = [pathOf('task.create'), pathOf('task.board'), pathOf('task.read')];
const [board, NO] = [JSON.stringify({ board: null }), 'AUTH_UNKNOWN_LOGIN'];
const padded = (bytes: number, value: object) => JSON.stringify(value).padEnd(bytes);
const TABLES = ['audit_events', 'operations', 'records', 'grants', 'authentication_attempts'];
const count = (from: string, where = 'true') =>
  `(select count(*)::int from public.${from} where business_id = $1 and ${where})`;
const COUNTS = `select ${TABLES.map((table) => `${count(table)} as ${table}`).join(', ')},
  ${count('authentication_attempts', "refusal_code = 'COMMAND_BODY_INVALID'")} as refused,
  ${count('authentication_attempts', "refusal_code = 'AUTH_NO_MEMBERSHIP'")} as strangers`;
type Counts = Record<string, number>;
type Party = Record<'id' | 'key' | 'title' | 'read' | 'member' | 'client', string>;
const plus = (counts: Counts, delta: Counts) =>
  Object.fromEntries(Object.entries(counts).map(([key, n]) => [key, n + (delta[key] ?? 0)]));

const now = () => Math.floor(Date.now() / 1000);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const GOTRUE = { sub: 'mia', aud: 'authenticated', iss: ISSUER };
const claims = (over: object = {}) => ({ ...GOTRUE, iat: now(), exp: now() + 600, ...over });
const PAST = { exp: now() - 60 };

async function swapped(): Promise<string> {
  const [header, , signature] = (await signBearer(claims(PAST))).split('.');
  return `${header}.${b64(claims({ ...PAST, sub: 'eve' }))}.${signature}`;
}

const CASES: readonly (readonly [string, () => Promise<string>, string])[] = [
  ['CQ-1 audience refused: another', () => signBearer(claims({ aud: 'anon' })), NO],
  ['CQ-1 issuer refused: another', () => signBearer(claims({ iss: `${ISSUER}/` })), NO],
  ['CQ-1 issuer refused: none', () => signBearer(claims({ iss: undefined })), NO],
  ['CQ-1 algorithm refused: none', async () => `${b64({ alg: 'none' })}.${b64(claims())}.`, NO],
  ['CQ-1 algorithm refused: HS512', () => sign(claims(), 'a-shared-secret', 'HS512'), NO],
  ['CQ-1 future nbf refused', () => signBearer(claims({ nbf: now() + 600 })), NO],
  ['CQ-1 expired still expired', () => signBearer(claims(PAST)), 'AUTH_SESSION_EXPIRED'],
  ['CQ-1 forged expired: another secret', () => signForged(claims(PAST)), NO],
  ['CQ-1 forged expired: payload swapped', swapped, NO],
  ['CQ-1 forged expired: another issuer', () => signBearer(claims({ ...PAST, iss: 'x' })), NO],
];

/** A read that runs, then faults: the trace sink, the composed server's onError, sees it. */
const fault: typeof executeRead = (...a) =>
  executeRead(...a).then(() => Promise.reject(new Error('a fault past the door')));
const FAULTY = { signIn: testSignIn(ISSUER), executeRead: fault, keys: runtimeKeys({}) };

async function send(api: Hono, path: string, body: string | ReadableStream, token: string) {
  const headers = { ...authorised(token), [DELEGATION_HEADER]: `probe-${randomUUID()}` };
  const init = { method: 'POST', headers, body, duplex: 'half' } as RequestInit;
  const response = await api.fetch(new Request(`http://api.test${path}`, init));
  return { status: response.status, text: await response.text() };
}

/** A business with a member holding one grant, write, and a client holding one, a share. */
async function party(fixture: ApiFixture, api: Hono, key: string): Promise<Party> {
  const [id, title, subject] = [await insertBusiness(fixture.db.app, key), randomUUID(), key];
  await installSpine(fixture.db.app, id);
  const member = await enrol(fixture.db.app, id, `${key}-member`);
  await fixture.db.app.withBusiness(id, async (tx) => await grantTo(tx, member, 'write'));
  const token = await tokenFor(member.presented.subject);
  const task = JSON.stringify({ operationId: randomUUID(), fields: { title } });
  const { recordId } = JSON.parse((await send(api, `/api/b/${key}${CREATE}`, task, token)).text);
  await fixture.db.app.withBusiness(id, async (tx) => {
    const personId = await insertPerson(tx, `${key}-client`);
    await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, member.actorId);
    await grantTo(tx, { ...member, personId }, 'read', { kind: 'record', id: recordId });
  });
  const read = JSON.stringify({ recordId });
  return { id, key, title, read, member: token, client: await tokenFor(subject) };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-1 sign-in and request body', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let bravo: Party;
  let charlie: Party;
  const token = { member: '', agent: '' };
  const counts = async (business: string) =>
    (await fixture.db.admin.execute<Counts>(COUNTS, [business]))[0] as Counts;

  beforeAll(async () => {
    fixture = await createApiFixture('cq1');
    api = fixture.compose();
    token.member = await tokenFor(fixture.member.presented.subject);
    token.agent = await tokenFor(fixture.agent.subject);
    bravo = await party(fixture, api, 'bravo');
    charlie = await party(fixture, api, 'charlie');
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  for (const path of ['/api/b/alpha/task/create', '/api/a/b/alpha/task/queue']) {
    for (const [name, bearer, code] of CASES) {
      it(`${name} (${path})`, async () => {
        const answer = await send(api, path, '{}', await bearer());
        expect(JSON.parse(answer.text).code).toBe(code);
      });
    }
  }

  it('CQ-1 body limit boundary: exactly 1 MiB is accepted and runs', async () => {
    const body = padded(MIB, { operationId: randomUUID(), fields: { title: 'at-the-limit' } });
    const before = await counts(fixture.business);
    expect((await send(api, `/api/b/alpha${CREATE}`, body, token.member)).status).toBe(200);
    const { records, refused } = await counts(fixture.business);
    expect([records, refused]).toStrictEqual([Number(before['records']) + 1, before['refused']]);
  });

  for (const [who, door] of Object.entries({ member: '/api/b/alpha', agent: '/api/a/b/alpha' })) {
    for (const streamed of [false, true]) {
      it(`CQ-1 body limit boundary (${who}, streamed ${streamed}): one byte over is refused`, async () => {
        const text = padded(MIB + 1, { operationId: randomUUID(), fields: { title: 'over' } });
        const body = streamed ? new Blob([text]).stream() : text;
        const before = await counts(fixture.business);
        const answer = await send(api, `${door}${CREATE}`, body, token[who as 'member' | 'agent']);
        expect(`${answer.status} ${JSON.parse(answer.text).code}`).toBe('400 COMMAND_BODY_INVALID');
        const after = await counts(fixture.business);
        expect(after).toStrictEqual(plus(before, { refused: 1, authentication_attempts: 1 }));
      });
    }
  }

  it('CQ-1 isolation: two businesses, two clients, one grant each; neither reaches the other', async () => {
    const both = [bravo, charlie];
    const sees = async (p: Party, who: string, body: string) => {
      const answer = await send(api, `/api/b/${p.key}${body === board ? BOARD : READ}`, body, who);
      return [answer.status === 200, answer.text.includes(p.title)];
    };
    const own = await Promise.all(both.map((p) => sees(p, p.client, p.read)));
    expect(own.flat()).not.toContain(false);
    const watched = [bravo.id, charlie.id, fixture.business];
    const before = await Promise.all(watched.map((id) => counts(id)));
    const tries = both.flatMap((theirs, i) => {
      const mine = both[1 - i] as Party;
      const bodies = [theirs.read, board, padded(MIB + 1, {}), '[]'];
      return [mine.member, mine.client].flatMap((who) => bodies.map((b) => sees(theirs, who, b)));
    });
    expect((await Promise.all(tries)).flat()).not.toContain(true);
    // The target keeps its own door ledger, by digest (docs/local/API.md:70-76): I13's stranger
    // refusal per well-formed attempt, one body refusal per bad body. Nothing else, anywhere.
    const delta = { authentication_attempts: 8, strangers: 4, refused: 4 };
    const after = await Promise.all(watched.map((id) => counts(id)));
    expect(after).toStrictEqual(before.map((c, i) => (i < 2 ? plus(c, delta) : c)));
  });

  it('CQ-1 token canary: a planted token and secret reach no log, trace, refusal or stored row', async () => {
    const canary = `cq1-canary-${randomUUID()}`;
    const planted = await signBearer(claims({ aud: 'anon', canary }));
    const lines: unknown[] = [];
    const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const push = (...parts: unknown[]) => lines.push(...parts) > 0;
    const spies = [
      ...levels.map((level) => vi.spyOn(console, level).mockImplementation(push)),
      ...[process.stdout, process.stderr].map((s) => vi.spyOn(s, 'write').mockImplementation(push)),
    ];
    const faulty = composeApi({ ...FAULTY, database: fixture.db.app, admin: fixture.db.admin });
    const secretish = JSON.stringify({ secretish: `SUPABASE_JWT_SECRET=${canary}` });
    const answers = await Promise.all([
      send(api, `/api/b/alpha${CREATE}`, '{}', planted),
      send(api, `/api/b/alpha${CREATE}`, secretish.padEnd(MIB + 1), token.member),
      send(api, `/api/b/alpha${CREATE}`, secretish, token.member),
      send(faulty.app, `/api/b/alpha${BOARD}`, secretish, token.member),
    ]).finally(() => spies.forEach((spy) => spy.mockRestore()));
    const dump = (t: string) => fixture.db.admin.execute(`select x::text from public.${t} x`);
    const stored = await Promise.all(TABLES.map(dump));
    const seen = JSON.stringify([answers, lines.map(String), stored]);
    expect([answers[3]?.status, seen.includes('api: unhandled')]).toStrictEqual([503, true]);
    for (const value of [canary, planted, token.member]) expect(seen).not.toContain(value);
  });

  it('CQ-1 runtime deps: hono and @hono/node-server are runtime, pinned and recorded', () => {
    const pkg = JSON.parse(file('package.json')) as Record<string, Record<string, string>>;
    for (const name of ['hono', '@hono/node-server']) {
      const row = new RegExp(`\\| \`${name}\` +\\| ${pkg['dependencies']?.[name]} +\\|`, 'u');
      expect(pkg['devDependencies']?.[name]).toBeUndefined();
      expect(file('docs/supply-chain-pins.md')).toMatch(row);
    }
  });

  it('CQ-1 audit clean: pnpm audit reports no moderate or high advisory on hono', () => {
    const run = spawnSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8' });
    const advisories: Record<string, string>[] = Object.values(JSON.parse(run.stdout).advisories);
    const found = advisories.map((a) => `${a['module_name']} ${a['severity']}`);
    expect(found.filter((l) => /hono.* (moderate|high|critical)$/u.test(l))).toStrictEqual([]);
  }, 120_000);
});

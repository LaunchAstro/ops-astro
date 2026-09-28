// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-2: fault text kept out of logs, and the keys kept out of the process environment.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { ReadExecutor } from '../../apps/api/app.ts';
import { authorised, createApiFixture, ISSUER, post, SECRET, tokenFor } from './fixture.ts';
import type { ApiFixture } from './fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertActor, insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import {
  gateSigningKey,
  runtimeKeys,
} from '../../packages/core-records/src/commands/runtime-config.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/authority/credential-keys.ts';
import { parseCredentialKeys } from '../../packages/core-records/src/authority/credential-keys.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const [CREATE, READ, UPDATE] = [pathOf('task.create'), pathOf('task.read'), pathOf('task.update')];
const [BOARD, QUEUE, PEOPLE] = [pathOf('task.board'), pathOf('task.queue'), pathOf('person.list')];
const TABLES = 'audit_events operations records grants authentication_attempts'.split(' ');
const NAMES = JSON.stringify(['GATE_SIGNING_', 'DELEGATION_CREDENTIAL_KEY']);
const DEAD = 'postgres://cq2@127.0.0.1:1/cq2';
const URLS = ['DATABASE_URL', 'DATABASE_ADMIN_URL'].map((name) => process.env[name] ?? DEAD);
type Task = Record<'title' | 'recordId' | 'client', string> & { person?: string };
type Party = { key: string; member: string; tasks: Task[]; add: (name: string) => Promise<Task> };

/** No answer names another client's task: its title, its id, or its person. */
function expectOtherClientHidden(response: string, other: Task): void {
  const theirs = [other.title, other.recordId, other.person ?? other.title];
  expect(theirs.filter((value) => response.includes(value))).toStrictEqual([]);
}
const ghost = (t: Task): Task => ({ ...t, recordId: randomUUID() });
const ids = (text: string) => [
  ...new Set(text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu)),
];

/** `node apps/api/server.ts`, printing the key settings it holds once listening, or at exit. */
function start(settings: Record<string, string>, [url, admin]: readonly string[] = [DEAD, DEAD]) {
  const report = `const held = () => console.error('CQ2-ENV', JSON.stringify(Object.keys(process.env)
    .filter((name) => ${NAMES}.some((prefix) => name.startsWith(prefix)))));
  process.on('exit', held); const log = console.log; console.log = (...parts) => { log(...parts);
    if (String(parts[0]).startsWith('api: listening')) setImmediate(() => process.exit(0)); };`;
  const preload = `data:text/javascript,${encodeURIComponent(report)}`;
  const env = { PATH: process.env['PATH'], DATABASE_URL: url, DATABASE_ADMIN_URL: admin };
  const settled = { ...env, SUPABASE_JWT_SECRET: SECRET, GOTRUE_URL: ISSUER, API_PORT: '0' };
  const options = { cwd: ROOT, env: { ...settled, ...settings }, timeout: 60_000 };
  const run = spawnSync(process.execPath, ['--import', preload, 'apps/api/server.ts'], options);
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

async function logged<T>(run: () => Promise<T>): Promise<[T, string]> {
  const lines: unknown[] = [];
  const push = (...parts: unknown[]) => lines.push(...parts) > 0;
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const spies = [
    ...levels.map((level) => vi.spyOn(console, level).mockImplementation(push)),
    ...[process.stdout, process.stderr].map((s) => vi.spyOn(s, 'write').mockImplementation(push)),
  ];
  const result = await run().finally(() => spies.forEach((spy) => spy.mockRestore()));
  return [result, lines.map(String).join('\n')];
}

const send = async (api: Hono, path: string, body: object, token: string) =>
  await post(api, path, body, authorised(token));

describe('CQ-2 start-up', () => {
  it('CQ-2 malformed keyring: start-up stops naming the setting, never a key byte', () => {
    const bytes = randomBytes(16).toString('base64url');
    const keyring = { DELEGATION_CREDENTIAL_KEYS: `cq2@1:${bytes}` };
    const { status, output } = start({ DELEGATION_CREDENTIAL_KEY_ID: 'cq2@1', ...keyring });
    expect(status).toBe(1);
    expect(output).toContain('api: delegation credential keys: DELEGATION_CREDENTIAL_KEYS');
    expect(output).not.toContain(bytes);
  });
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-2 logs and faults', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;
  const dump = async (tables = TABLES) => {
    const all = tables.map((t) => fixture.db.admin.execute(`select x::text from public.${t} x`));
    return JSON.stringify(await Promise.all(all));
  };

  const composed = (executeRead: ReadExecutor, keys = runtimeKeys({ ...fixture.environment })) => {
    const { app, admin } = fixture.db;
    const config = { database: app, admin, secret: SECRET, issuer: ISSUER, keys, executeRead };
    return composeApi(config).app;
  };

  async function faulting(body: object, fault?: Error) {
    const faulty = composed(async (...args: unknown[]): Promise<never> => {
      if (fault !== undefined) throw fault;
      await fixture.db.admin.execute('select $1::uuid', [(args[3] as Task).recordId]);
      throw new Error('unreachable');
    });
    return await logged(async () => await send(faulty, `/api/b/alpha${READ}`, body, token));
  }

  /** A business whose member holds one grant, write, and two clients one read of a task each. */
  async function party(key: string): Promise<Party> {
    const id = await insertBusiness(fixture.db.app, key);
    await installSpine(fixture.db.app, id);
    const member = await enrol(fixture.db.app, id, `${key}-member`);
    await fixture.db.app.withBusiness(id, async (tx) => await grantTo(tx, member, 'write'));
    const own = await tokenFor(member.presented.subject);
    const add = async (client: string): Promise<Task> => {
      const task = { operationId: randomUUID(), fields: { title: `cq2-${randomUUID()}` } };
      const { body } = await send(api, `/api/b/${key}${CREATE}`, task, own);
      const recordId = String(body['recordId']);
      const person = await fixture.db.app.withBusiness(id, async (tx) => {
        const personId = await insertPerson(tx, `${client}-${randomUUID()}`);
        await insertActor(tx, personId);
        await insertMapping(tx, await insertLogin(tx, client), personId, member.actorId);
        await grantTo(tx, { ...member, personId }, 'read', { kind: 'record', id: recordId });
        return personId;
      });
      return { title: task.fields.title, recordId, person, client: await tokenFor(client) };
    };
    const tasks = await Promise.all([1, 2].map(async (n) => await add(`${key}-client-${n}`)));
    return { key, member: own, tasks, add };
  }

  beforeAll(async () => {
    fixture = await createApiFixture('cq2');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  it('CQ-2 process.env: after start-up it holds no key the server put there', () => {
    const gate = join(ROOT, '.local', 'gate.env');
    const wrote = !existsSync(gate);
    mkdirSync(join(ROOT, '.local'), { recursive: true });
    if (wrote)
      writeFileSync(gate, `GATE_SIGNING_KEY_ID=cq2@1\nGATE_SIGNING_SECRET=${randomUUID()}`);
    expect(runtimeKeys({}).delegation.ok).toBe(true);
    // The keys are in the checkout's files only; the server recovers, listens, then reports.
    const { status, output } = start({ RECOVERY_BUSINESS_KEYS: 'none' }, URLS);
    if (wrote) rmSync(gate);
    expect([status, output]).toStrictEqual([
      0,
      expect.stringMatching(/listening[^]*CQ2-ENV \[\]/u),
    ]);
  });
  it('CQ-2 database error log: the log line holds the error code and command name, never the value', async () => {
    const value = `cq2-value-${randomUUID()}`;
    const { app } = fixture.db;
    // Every transaction first sends the value where Postgres wants a uuid: 22P02, quoting it.
    const quoting: Database = {
      ...app,
      withBusiness: async (business, run) =>
        await app.withBusiness(business, async (tx) => {
          await tx.query('select $1::uuid', [value]);
          return await run(tx);
        }),
    };
    const request = { command: 'task.create', operationId: randomUUID(), fields: { title: value } };
    const at = [quoting, fixture.business as BusinessId, fixture.member.presented, 'api'] as const;
    const [raised, log] = await logged(async () =>
      executeCommand(...at, request as never).catch((cause: unknown) => cause),
    );
    expect((raised as Error).message).toContain(value);
    expect(log).toMatch(/at task\.create could not be recorded \(22P02\).*failed with 22P02/u);
    expect(log).not.toContain(value);
  });

  it('CQ-2 unhandled error: planted personal data and a canary secret reach no log, trace, response or alert', async () => {
    const planted = `Jane Citizen, jane.citizen@example.com, SUPABASE_JWT_SECRET=${randomUUID()}`;
    const traces = () => [fixture.db.app.log.entries, fixture.db.admin.log.entries].flat();
    const traced = traces().length;
    const [answer, log] = await faulting({ recordId: randomUUID() }, new Error(planted));
    expect([answer.status, answer.body['code']]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    // The alert an operator gets is raised from this line; nothing is NOTIFY'd from the fault.
    const alert = log.split('\n').filter((line) => line.startsWith('api: unhandled fault'));
    expect(alert).toStrictEqual([expect.stringMatching(/^api: unhandled fault Error \(ref/u)]);
    const trace = JSON.stringify(traces().slice(traced));
    expect([trace.length > 2, /\bNOTIFY\b/iu.test(trace)]).toStrictEqual([true, false]);
    const seen = JSON.stringify([answer.body, log, trace, alert]) + (await dump());
    for (const part of planted.split(', ')) expect(seen).not.toContain(part);
  });

  it('CQ-2 owner check: the log from a deliberately bad request says what failed and none of the request', async () => {
    const recordId = `not-a-record-${randomUUID()}`;
    const [answer, log] = await faulting({ recordId });
    expect(answer.status).toBe(503);
    expect(log).toMatch(/unhandled fault 22P02 \(reference [0-9a-f-]{36}\): the request could/u);
    expect(log).not.toContain(recordId);
  });

  it('CQ-2 canary: a planted canary secret and record content reach no log, error, trace, response or audit payload', async () => {
    const canary = `GATE_SIGNING_SECRET=cq2-canary-${randomUUID()}`;
    const create = { operationId: randomUUID(), fields: { title: canary } };
    const [made, log] = await logged(async () => send(api, `/api/b/alpha${CREATE}`, create, token));
    const [faulted, faultLog] = await faulting({ recordId: canary });
    expect([made.status, faulted.status]).toStrictEqual([200, 503]);
    const traces = JSON.stringify(fixture.db.app.log.entries) + (await dump(['audit_events']));
    const all = [made.body, faulted.body, log, faultLog, traces];
    expect(JSON.stringify(all)).not.toContain(canary);
  });

  it('CQ-2 isolation: two businesses, two clients, one grant each; neither reaches the other', async () => {
    const [b, c] = [await party('bravo'), await party('charlie')];
    // Read, list, count (the board's and queue's), export, change and the people list, as `who`.
    const tries = (p: Party, t: Task, who: string) =>
      Object.entries({
        [READ]: { recordId: t.recordId },
        [BOARD]: { board: null },
        [QUEUE]: {},
        '/task/export': {},
        [UPDATE]: {
          operationId: randomUUID(),
          recordId: t.recordId,
          expectedRevision: 1,
          fields: { title: 'cq2-changed' },
        },
        [PEOPLE]: {},
      }).map(async ([path, body]) => await send(api, `/api/b/${p.key}${path}`, body, who));
    const reached = async (p: Party, t: Task, who: string) =>
      JSON.stringify((await Promise.all(tries(p, t, who))).map((a) => [a.status, a.body]));
    // Each client reads its own task. Another client's in the same business is answered as a
    // made-up id is, and no answer names another record, another person or a title not its own.
    const records = await dump(['records']);
    const clients = [b, c].map(async (p) => {
      const [one, two] = p.tasks as [Task, Task];
      const [own, other, none, others] = await Promise.all([
        reached(p, one, one.client),
        reached(p, two, one.client),
        reached(p, ghost(two), one.client),
        reached(p, one, two.client),
      ]);
      expect([own.startsWith('[[200,'), own.includes(one.title)]).toEqual([true, true]);
      expect(other).toBe(none);
      // The only ids any answer to a client carries are its own task's: no other record or person.
      const mine = ids(`${one.recordId} ${one.title}`).toSorted();
      expect([ids([own, other, none].join()).toSorted(), ids(others)]).toStrictEqual([mine, []]);
      expectOtherClientHidden(other, two);
      expectOtherClientHidden(others, one);
    });
    await Promise.all(clients);
    expect(await dump(['records'])).toBe(records);
    // Counts: another client's task and person arriving change nothing the first client sees.
    const [first] = b.tasks as [Task];
    const was = await reached(b, first, first.client);
    await b.add('bravo-client-3');
    expect(await reached(b, first, first.client)).toBe(was);
    // A stranger's refusal is the target's own door ledger (CQ-1); nothing else may change.
    const before = await dump(TABLES.slice(0, 4));
    const strangers = [c, b].flatMap((p) => [p.member].concat(p.tasks.map((t) => t.client)));
    const [crossed, log] = await logged(async () => {
      const target = (i: number) => (i < 3 ? b : c);
      const all = strangers.flatMap((who, i) =>
        target(i).tasks.map((t) => reached(target(i), t, who)),
      );
      return await Promise.all(all);
    });
    expect(`${crossed}`).not.toMatch(/\[200,/u);
    expect(await dump(TABLES.slice(0, 4))).toBe(before);
    for (const t of [b, c].flatMap((p) => p.tasks))
      expect(`${crossed}${log}`).not.toContain(t.title);
    // The records were changeable all along: their own member's change goes through.
    expect((await Promise.all(tries(b, first, b.member)))[4]?.status).toBe(200);
  });

  it('Sol proof, criterion 4: isolation catches another client task ID', () => {
    const other: Task = { title: 'hidden title', recordId: randomUUID(), client: 'client-b' };
    const leaked = JSON.stringify([[200, { taskId: other.recordId }]]);
    expect(() => expectOtherClientHidden(leaked, other)).toThrow();
  });

  it('CQ-2 keys per app: a second composition leaves the first app its own keys', async () => {
    const seen: string[] = [];
    const noting: ReadExecutor = async () => {
      const ring = configuredCredentialKeys();
      seen.push(`${gateSigningKey()?.id} ${ring.ok ? ring.keys.activeKeyId : ''}`);
      throw new Error('noted');
    };
    const [one, two] = ['cq2/first@1', 'cq2/second@1'].map((id) => {
      const delegation = parseCredentialKeys(id, `${id}:${randomBytes(32).toString('base64url')}`);
      return composed(noting, { gate: { id, secret: randomUUID() }, delegation });
    }) as [Hono, Hono];
    const read = async (app: Hono) =>
      await send(app, `/api/b/alpha${READ}`, { recordId: randomUUID() }, token);
    await logged(async () => await Promise.all([one, two, one].map(read)));
    expect(seen.toSorted()).toStrictEqual(
      ['first', 'first', 'second'].map((n) => `cq2/${n}@1 cq2/${n}@1`),
    );
    expect(String(gateSigningKey()?.id)).not.toMatch(/^cq2\//u);
  });
});

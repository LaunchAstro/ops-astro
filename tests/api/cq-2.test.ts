// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-2: fault text kept out of logs, and the keys kept out of the process environment.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { authorised, createApiFixture, ISSUER, post, SECRET, tokenFor } from './fixture.ts';
import type { ApiFixture } from './fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertActor, insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { runtimeKeys } from '../../packages/core-records/src/commands/runtime-config.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const [CREATE, READ] = [pathOf('task.create'), pathOf('task.read')];
const TABLES = 'audit_events operations records grants authentication_attempts'.split(' ');
const NAMES = JSON.stringify(['GATE_SIGNING_', 'DELEGATION_CREDENTIAL_KEY']);
const DEAD = 'postgres://cq2@127.0.0.1:1/cq2';
type Party = Record<'key' | 'title' | 'recordId' | 'member' | 'client', string>;

/** `node apps/api/server.ts` over no database, printing the key settings it holds at exit. */
function start(settings: Record<string, string>) {
  const report = `process.on('exit', () => console.error('CQ2-ENV', JSON.stringify(Object.keys(
    process.env).filter((name) => ${NAMES}.some((prefix) => name.startsWith(prefix))))));`;
  const preload = `data:text/javascript,${encodeURIComponent(report)}`;
  const settled = { SUPABASE_JWT_SECRET: SECRET, GOTRUE_URL: ISSUER, API_PORT: '0', ...settings };
  const env = { PATH: process.env['PATH'], DATABASE_URL: DEAD, DATABASE_ADMIN_URL: DEAD };
  const options = {
    cwd: ROOT,
    env: { ...env, ...settled },
    encoding: 'utf8' as const,
    timeout: 60_000,
  };
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
  it('CQ-2 process.env: after start-up it holds no key the server put there', () => {
    const gate = join(ROOT, '.local', 'gate.env');
    const wrote = !existsSync(gate);
    mkdirSync(join(ROOT, '.local'), { recursive: true });
    if (wrote)
      writeFileSync(gate, `GATE_SIGNING_KEY_ID=cq2@1\nGATE_SIGNING_SECRET=${randomUUID()}`);
    expect(runtimeKeys({}).delegation.ok).toBe(true);
    // The keys are in the checkout's files only, and recovery then stops the start.
    const { status, output } = start({ RECOVERY_BUSINESS_KEYS: '' });
    if (wrote) rmSync(gate);
    expect([status, output]).toStrictEqual([1, expect.stringContaining('CQ2-ENV []')]);
    expect(output).toContain('RECOVERY_BUSINESS_KEYS is not set');
  });

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

  async function faulting(body: object, fault?: Error) {
    const executeRead = async (...args: unknown[]): Promise<never> => {
      if (fault !== undefined) throw fault;
      await fixture.db.admin.execute('select $1::uuid', [(args[3] as Party).recordId]);
      throw new Error('unreachable');
    };
    const { db, environment } = fixture;
    const keys = runtimeKeys({ ...environment });
    const config = { database: db.app, admin: db.admin, secret: SECRET, issuer: ISSUER, keys };
    const faulty = composeApi({ ...config, executeRead }).app;
    return await logged(async () => await send(faulty, `/api/b/alpha${READ}`, body, token));
  }

  /** A business whose member holds one grant, write, and whose client one read of one task. */
  async function party(key: string): Promise<Party> {
    const [id, title] = [await insertBusiness(fixture.db.app, key), `cq2-${randomUUID()}`];
    await installSpine(fixture.db.app, id);
    const member = await enrol(fixture.db.app, id, `${key}-member`);
    await fixture.db.app.withBusiness(id, async (tx) => await grantTo(tx, member, 'write'));
    const own = await tokenFor(member.presented.subject);
    const task = { operationId: randomUUID(), fields: { title } };
    const made = await send(api, `/api/b/${key}${CREATE}`, task, own);
    const recordId = String(made.body['recordId']);
    await fixture.db.app.withBusiness(id, async (tx) => {
      const personId = await insertPerson(tx, `${key}-client`);
      await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, `${key}-client`), personId, member.actorId);
      await grantTo(tx, { ...member, personId }, 'read', { kind: 'record', id: recordId });
    });
    return { key, title, recordId, member: own, client: await tokenFor(`${key}-client`) };
  }

  beforeAll(async () => {
    fixture = await createApiFixture('cq2');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
  }, 60_000);

  afterAll(async () => await fixture?.drop());

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
    const [answer, log] = await faulting({ recordId: randomUUID() }, new Error(planted));
    expect([answer.status, answer.body['code']]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    expect(log).toMatch(/api: unhandled fault Error \(reference [0-9a-f-]{36}\)/u);
    const seen = JSON.stringify([answer.body, log]) + (await dump());
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
    expect(JSON.stringify([faulted.body, log, faultLog, traces])).not.toContain(canary);
  });

  it('CQ-2 isolation: two businesses, two clients, one grant each; neither reaches the other', async () => {
    const [b, c] = [await party('bravo'), await party('charlie')];
    const reads = async (p: Party, who: string) => {
      const { body } = await send(api, `/api/b/${p.key}${READ}`, { recordId: p.recordId }, who);
      return JSON.stringify(body).includes(p.title);
    };
    expect(await Promise.all([reads(b, b.client), reads(c, c.client)])).toEqual([true, true]);
    // A stranger's refusal is the target's own door ledger (CQ-1); nothing else may change.
    const before = await dump(TABLES.slice(0, 4));
    const strangers = [c.member, c.client, b.member, b.client];
    const cross = strangers.map((who, i) => async () => await reads(i < 2 ? b : c, who));
    const [crossed, log] = await logged(async () => await Promise.all(cross.map((r) => r())));
    expect(crossed).toStrictEqual([false, false, false, false]);
    expect(await dump(TABLES.slice(0, 4))).toBe(before);
    expect([log.includes(b.title), log.includes(c.title)]).toStrictEqual([false, false]);
  });
});

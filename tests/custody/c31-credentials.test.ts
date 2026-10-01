// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// C31: the credentials screen's custody command, over HTTP against a real
// database. Each case is named after the acceptance line or supporting
// checklist line it proves (U33, #494).
//
// The value a caller sets is sealed to the broker's public key before any
// statement is built, and no path hands it back. So the cases below plant a
// canary value and then look everywhere it could have gone: every answer,
// everything the process wrote to its output, and every row of every table.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import {
  generateSealingPair,
  markSecretUsed,
  open,
  seal,
} from '../../packages/core-records/src/custody/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';

const serverUrl = databaseUrlFromEnvironment();
const CANARY = `canary-${randomUUID()}-do-not-log`;
const CANARY_HEX = Buffer.from(CANARY).toString('hex');

interface SecretView {
  readonly id: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly state: 'set' | 'not set';
  readonly setAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revision: number;
}

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C31 credentials screen (custody)', () => {
  const pair = generateSealingPair('test/c31@1');
  let controls: Controls;
  let admin: Member;
  let plain: Member;
  let clientHolder: Member;
  let bravoAdmin: Member;
  const clientA = randomUUID();
  const clientB = randomUUID();
  const answers: Answer[] = [];
  const output: string[] = [];

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };

  const list = async (who: Member, business = 'alpha'): Promise<readonly SecretView[]> => {
    const answer = await as(who, 'secret.list', {}, business);
    expect(answer.status).toBe(200);
    return answer.body['secrets'] as readonly SecretView[];
  };

  const set = async (
    name: string,
    value: string,
    extra: Readonly<Record<string, unknown>> = {},
    who: Member = admin,
  ): Promise<Answer> => await as(who, 'secret.set', { name, value, ...extra });

  const rowCount = async (): Promise<number> =>
    await controls.count('select count(*) as n from public.custody_secrets', []);

  beforeAll(async () => {
    // Everything the process writes goes into `output` as well as through.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        output.push(String(chunk));
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[method].bind(console);
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(
          args.map((one) => (typeof one === 'string' ? one : JSON.stringify(one))).join(' '),
        );
        original(...args);
      });
    }

    controls = await createControls('c31', { custody: pair.key });
    const { db, business } = controls.fixture;
    admin = controls.manager;
    plain = await enrol(db.app, business, 'plain');
    clientHolder = await enrol(db.app, business, 'clientholder');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'manage', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, plain, 'read', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, plain, 'write', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, clientHolder, 'manage', { kind: 'party', id: clientA }, false, 'custody');
    });
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'manage', { kind: 'business', id: null }, false, 'custody');
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await controls?.drop();
  });

  it('C31 owner check: a set key shows "set" with no value, and a cleared one "not set"', async () => {
    const answer = await set('xero.client-secret', CANARY);
    expect(answer.status).toBe(200);
    const shown = (await list(admin)).find((one) => one.name === 'xero.client-secret');
    expect(shown?.state).toBe('set');
    expect(shown?.clientId).toBeNull();
    expect(JSON.stringify(shown)).not.toContain(CANARY);
    expect(Object.keys(shown ?? {}).toSorted()).toStrictEqual(
      ['clientId', 'id', 'lastUsedAt', 'name', 'revision', 'setAt', 'state'].toSorted(),
    );

    const cleared = await as(admin, 'secret.clear', { secretId: shown?.id });
    expect(cleared.status).toBe(200);
    const after = (await list(admin)).find((one) => one.name === 'xero.client-secret');
    expect(after?.state).toBe('not set');
    expect(after?.setAt).toBeNull();
  });

  it('C31 every change is recorded and joins the audit chain', async () => {
    const answer = await set('ads.token', `${CANARY}-audit`);
    const secretId = String((answer.body['detail'] as Record<string, unknown>)['secretId']);
    await as(admin, 'secret.clear', { secretId });
    const rows = await controls.fixture.db.admin.execute<{
      readonly command: string;
      readonly outcome: string;
      readonly hash: string;
    }>(
      `select command, outcome, hash from public.audit_events
        where actor_id = $1 and command in ('secret.set', 'secret.clear') order by seq`,
      [admin.actorId],
    );
    expect(
      rows.filter((row) => row.command === 'secret.set' && row.outcome === 'applied').length,
    ).toBeGreaterThan(0);
    expect(
      rows.filter((row) => row.command === 'secret.clear' && row.outcome === 'applied').length,
    ).toBeGreaterThan(0);
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/u);
    const history = await controls.fixture.db.admin.execute<{
      readonly set_by_actor_id: string | null;
      readonly cleared_by_actor_id: string | null;
    }>(`select set_by_actor_id, cleared_by_actor_id from public.custody_secrets where id = $1`, [
      secretId,
    ]);
    expect(history[0]?.cleared_by_actor_id).toBe(admin.actorId);
  });

  it('C31 refusal custody:manage: read and write holders are refused set, clear and list', async () => {
    const before = await rowCount();
    const setting = await set('plain.try', `${CANARY}-plain`, {}, plain);
    expect(setting.status).toBe(403);
    expect(setting.body['code']).toBe('SCOPE_NOT_GRANTED');
    const target = await set('plain.target', `${CANARY}-target`);
    const secretId = String((target.body['detail'] as Record<string, unknown>)['secretId']);
    const clearing = await as(plain, 'secret.clear', { secretId });
    expect(clearing.status).toBe(403);
    expect(clearing.body['code']).toBe('SCOPE_NOT_GRANTED');
    const listing = await as(plain, 'secret.list', {});
    expect(listing.status).toBe(403);
    expect(listing.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await rowCount()).toBe(before + 1);
    const still = (await list(admin)).find((one) => one.id === secretId);
    expect(still?.state).toBe('set');
  });

  it('C31 refusal custody:manage: an agent never holds it, even under a live delegation', async () => {
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const reservationId = await controls.approve(proposal);
    const picked = await controls.pickup(reservationId);
    const credential = String(picked['credential']);
    const before = await rowCount();
    for (const [name, body] of [
      ['secret.list', {}],
      ['secret.set', { name: 'agent.try', value: `${CANARY}-agent` }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await controls.asAgent(name, body, credential);
      answers.push(answer);
      expect(answer.status).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
      expect(answer.body['secrets']).toBeUndefined();
    }
    expect(await rowCount()).toBe(before);
  });

  it('C31 isolation: another business never sees, counts or clears these secrets', async () => {
    const mine = await set('isolation.alpha', `${CANARY}-alpha`);
    const secretId = String((mine.body['detail'] as Record<string, unknown>)['secretId']);
    const theirs = await list(bravoAdmin, 'bravo');
    expect(theirs).toStrictEqual([]);
    const clearing = await as(bravoAdmin, 'secret.clear', { secretId }, 'bravo');
    expect(clearing.status).toBe(404);
    expect(clearing.body['code']).toBe('NOT_FOUND');
    const fabricated = await as(bravoAdmin, 'secret.clear', { secretId: randomUUID() }, 'bravo');
    const malformed = await as(bravoAdmin, 'secret.clear', { secretId: 'not-a-uuid' }, 'bravo');
    for (const other of [fabricated, malformed]) {
      expect(other.status).toBe(clearing.status);
      expect(other.body).toStrictEqual(clearing.body);
    }
    expect((await list(admin)).find((one) => one.id === secretId)?.state).toBe('set');
  });

  it('C31 isolation: a client-scoped holder sees that client only, and writes nothing', async () => {
    await set('google.refresh', `${CANARY}-a`, { clientId: clientA });
    await set('google.refresh', `${CANARY}-b`, { clientId: clientB });
    const shown = await list(clientHolder);
    expect(shown.length).toBeGreaterThan(0);
    for (const one of shown) expect(one.clientId).toBe(clientA);
    const all = await list(admin);
    const other = all.find((one) => one.clientId === clientB);
    expect(other).toBeDefined();
    expect(JSON.stringify(shown)).not.toContain(clientB);
    expect(JSON.stringify(shown)).not.toContain(other?.id ?? 'none');

    const before = await rowCount();
    const setting = await set('google.refresh', `${CANARY}-c`, { clientId: clientA }, clientHolder);
    expect(setting.status).toBe(403);
    const clearing = await as(clientHolder, 'secret.clear', { secretId: other?.id });
    expect(clearing.status).toBe(403);
    expect(JSON.stringify(clearing.body)).not.toContain(clientB);
    expect(await rowCount()).toBe(before);
    expect((await list(admin)).find((one) => one.id === other?.id)?.state).toBe('set');
  });

  it('C31 last used readback: a use moves last used, and setting again does not', async () => {
    const answer = await set('used.key', `${CANARY}-used`);
    const secretId = String((answer.body['detail'] as Record<string, unknown>)['secretId']);
    expect((await list(admin)).find((one) => one.id === secretId)?.lastUsedAt).toBeNull();
    const { db, business } = controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      expect(await markSecretUsed(tx, secretId)).toBe(true);
    });
    const used = (await list(admin)).find((one) => one.id === secretId)?.lastUsedAt;
    expect(used).not.toBeNull();
    await set('used.key', `${CANARY}-used-again`);
    expect((await list(admin)).find((one) => one.id === secretId)?.lastUsedAt).toBe(used);
  });

  it('C31 a stale revision is refused and the value stays', async () => {
    const first = await set('stale.key', `${CANARY}-1`);
    const revision = Number(first.body['revision']);
    expect((await set('stale.key', `${CANARY}-2`, { expectedRevision: revision })).status).toBe(
      200,
    );
    const stale = await set('stale.key', `${CANARY}-3`, { expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('VERSION_STALE');
  });

  it('C31 two setters at once leave one row, both applied in turn', async () => {
    const [one, two] = await Promise.all([
      set('race.key', `${CANARY}-r1`),
      set('race.key', `${CANARY}-r2`),
    ]);
    expect([one.status, two.status]).toStrictEqual([200, 200]);
    const rows = (await list(admin)).filter((row) => row.name === 'race.key');
    expect(rows.length).toBe(1);
    expect(rows[0]?.revision).toBe(2);
  });

  it('C31 malformed input is refused by field and never echoed', async () => {
    const before = await rowCount();
    for (const body of [
      { name: 'Bad Name!', value: `${CANARY}-bad` },
      { name: 'ok.name', value: 42 },
      { name: 'ok.name', value: '' },
      { name: 'ok.name', value: `${CANARY}-x`.padEnd(9_000, 'x') },
      { name: 'ok.name', value: `${CANARY}-y`, clientId: 'not-a-uuid' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await as(admin, 'secret.set', body);
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
    }
    expect(await rowCount()).toBe(before);
  });

  it('C31 no session token: a chat product session is refused by field and nothing is stored', async () => {
    // AW-01 and C60: the product never stores a Claude.ai or ChatGPT session
    // token, and custody's set is the one way a credential is stored. Each
    // shape custody refuses at load is refused here, bare, as a cookie pair
    // and percent-encoded, and never echoed.
    const before = await rowCount();
    for (const value of [
      `sk-ant-sid01-${CANARY}`,
      `sessionKey=sk-ant-sid01-${CANARY}`,
      encodeURIComponent(`__Secure-next-auth.session-token=${CANARY}`),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await set('session.try', value);
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    expect(await rowCount()).toBe(before);
    expect(await list(admin)).not.toContainEqual(expect.objectContaining({ name: 'session.try' }));
  });

  it('C31 no broker key configured: set refuses and stores nothing', async () => {
    const bare = controls.fixture.compose({ custody: undefined });
    const before = await rowCount();
    const answer = await post(
      bare,
      path('alpha', 'secret.set'),
      { operationId: randomUUID(), name: 'nokey.key', value: `${CANARY}-nokey` },
      authorised(await tokenFor(admin.presented.subject)),
    );
    answers.push(answer);
    expect(answer.status).toBe(501);
    expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    expect(await rowCount()).toBe(before);
  });

  it('C31 the application role cannot select a sealed value', async () => {
    const { db, business } = controls.fixture;
    await expect(
      db.app.withBusiness(
        business,
        async (tx) => await tx.query('select sealed from public.custody_secrets'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('C31 a sealed value opens only with the broker key', () => {
    const sealed = seal(CANARY, pair.key);
    expect(sealed.sealed.toString('hex')).not.toContain(CANARY_HEX);
    expect(open(sealed, pair.privateKey)).toBe(CANARY);
    const stranger = generateSealingPair('test/c31@1');
    expect(() => open(sealed, stranger.privateKey)).toThrow();
  });

  it('C31 parity: the three commands are catalogued custody:manage, person only', () => {
    for (const name of ['secret.list', 'secret.set', 'secret.clear']) {
      const row = COMMAND_SURFACE.find((one) => one.name === name);
      expect(row?.collection).toBe('custody');
      expect(row?.action).toBe('manage');
      expect(row?.agent).toBe('never');
    }
  });

  it('C31 canary: the planted value never reaches an answer, the output or any table', async () => {
    const { db } = controls.fixture;
    for (const answer of answers) expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    expect(output.join('\n')).not.toContain(CANARY);
    const tables = await db.admin.execute<{ readonly name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dumps = await Promise.all(
      tables.map(async ({ name }) => {
        const rows = await db.admin.execute<{ readonly dump: string | null }>(
          `select string_agg(t::text, E'\\n') as dump from public."${name}" t`,
        );
        return rows[0]?.dump ?? '';
      }),
    );
    const everything = dumps.join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(CANARY_HEX);
    expect(everything.length).toBeGreaterThan(0);
  });
});

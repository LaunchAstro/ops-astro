// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11a: the one preference store (supporting checklist lines C14 and C15).
//
// `preference.save` writes a key of the caller's own row under the self-scoped
// `preference:write`: no grant is asked and no body field names a person, so
// the only row it can reach is the caller's. `preference.read` answers the
// caller's own keys. The rail, dock and column widths are keys of this store
// (FG-O-5), never a table of their own. A saved preference is not audited
// (CS-2.8): an applied save adds no audit event, and a refused one still does.
//
// Separations, each exercised below: business to business (a person in another
// business neither reads nor writes here), client to client (people scoped to
// two clients of one business each reach only their own row), person to person
// (nobody reads or writes another person's keys, and an agent writes none).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Preferences = Readonly<Record<string, unknown>>;

/** Stored on Ada's row and looked for in every other caller's answer. */
const CANARY = `canary-${randomUUID()}`;

describe.skipIf(serverUrl === undefined)('MP-2-11a the one preference store', () => {
  let c: Controls;
  let fixture: ApiFixture;
  let api: Hono;
  let ada: Member;
  let adaToken = '';
  let ben: Member;
  let benToken = '';

  const call = async (
    name: string,
    body: Readonly<Record<string, unknown>>,
    token: string,
    options: { readonly key?: string; readonly agent?: boolean } = {},
  ): Promise<Answer> =>
    await post(
      api,
      `/api${options.agent === true ? '/a' : ''}/b/${options.key ?? BUSINESS_KEY}${pathOf(name as CommandName)}`,
      body,
      authorised(token),
    );
  const save = async (key: string, value: unknown, token: string, extra = {}): Promise<Answer> =>
    await call(
      'preference.save',
      { operationId: randomUUID(), preference: key, value, ...extra },
      token,
    );
  const read = async (token: string, key?: string): Promise<Preferences> => {
    const answer = await call('preference.read', {}, token, key === undefined ? {} : { key });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body['preferences'] as Preferences;
  };
  const rowsOf = async (personId: string): Promise<readonly { key: string; value: unknown }[]> =>
    (
      await fixture.db.admin.execute<{ key: string; value: unknown }>(
        `select key, value from public.person_preferences where person_id = $1 order by key`,
        [personId],
      )
    ).map((row) => ({ key: row.key, value: row.value }));
  const auditCount = async (actorId: string): Promise<number> => {
    const [row] = await fixture.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.audit_events
        where actor_id = $1 and command = 'preference.save'`,
      [actorId],
    );
    return Number(row?.n);
  };

  beforeAll(async () => {
    c = await createControls('mp211a');
    fixture = c.fixture;
    api = c.api;
    ada = await enrol(fixture.db.app, fixture.business, 'Ada Pref');
    ben = await enrol(fixture.db.app, fixture.business, 'Ben Pref');
    // A live grant each: `preference.read`, like the inbox reads, refuses a
    // caller holding none. The save asks no grant.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, ada, 'read');
      await grantTo(tx, ben, 'read');
    });
    adaToken = await tokenFor(ada.presented.subject);
    benToken = await tokenFor(ben.presented.subject);
    const canary = await save('columns.widths', { [CANARY]: 111 }, adaToken);
    expect(canary.status, JSON.stringify(canary.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** Nobody's answer but Ada's ever carries her stored canary. */
  const expectNoCanary = (answer: Answer): void => {
    expect(JSON.stringify(answer.body)).not.toContain(CANARY);
  };

  it('MP-2-11 own preference only: a write naming another person is refused and writes nothing', async () => {
    const first = await save('appearance', 'dark', adaToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const aimed = await save('appearance', 'light', benToken, { personId: ada.personId });
    expect(aimed.status).not.toBe(200);
    expect(await rowsOf(ada.personId)).toStrictEqual([
      { key: 'appearance', value: 'dark' },
      { key: 'columns.widths', value: { [CANARY]: 111 } },
    ]);
    expect(await rowsOf(ben.personId)).toStrictEqual([]);
    expectNoCanary(aimed);

    // Ben's own save reaches Ben's row alone, and each reads only their own.
    expect((await save('appearance', 'light', benToken)).status).toBe(200);
    expect(await read(adaToken)).toStrictEqual({
      appearance: 'dark',
      'columns.widths': { [CANARY]: 111 },
    });
    expect(await read(benToken)).toStrictEqual({ appearance: 'light' });
  });

  it('MP-2-11 widths in one store: the rail, dock and column widths round-trip as keys of the one store', async () => {
    const widths = {
      'rail.width': 240,
      'dock.width': 420,
      'dock.sheetHeight': 480,
      'columns.widths': { title: 320, state: 120 },
    };
    for (const [key, value] of Object.entries(widths)) {
      // Sequential: each save is its own operation, in order.
      // eslint-disable-next-line no-await-in-loop
      expect((await save(key, value, benToken)).status).toBe(200);
    }
    expect(await read(benToken)).toStrictEqual({ appearance: 'light', ...widths });

    const tables = await fixture.db.admin.execute<{ name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public'
          and (table_name like '%width%' or table_name like '%dock%' or table_name like '%rail%')`,
    );
    expect(tables.map((row) => row.name)).toStrictEqual([]);
  });

  it('MP-2-11a two saves of one key at once both apply and leave one row, the later value', async () => {
    const [left, right] = await Promise.all([
      save('dock.sheetHeight', 300, benToken),
      save('dock.sheetHeight', 310, benToken),
    ]);
    expect([left?.status, right?.status]).toStrictEqual([200, 200]);
    const rows = (await rowsOf(ben.personId)).filter((row) => row.key === 'dock.sheetHeight');
    expect(rows).toHaveLength(1);
    expect([300, 310]).toContain(rows[0]?.value);
  });

  it('MP-2-11a a second save of a key replaces its value; a replay returns the first answer', async () => {
    const operationId = randomUUID();
    const body = { operationId, preference: 'rail.width', value: 300 };
    const first = await call('preference.save', body, adaToken);
    expect(first.status).toBe(200);
    expect(await call('preference.save', body, adaToken)).toStrictEqual(first);
    expect((await read(adaToken))['rail.width']).toBe(300);
  });

  it('MP-2-11a an unknown key or a value the key does not take is refused and writes nothing', async () => {
    const before = await rowsOf(ada.personId);
    for (const [key, value] of [
      ['favourite.colour', 'teal'],
      ['appearance', 'sepia'],
      ['rail.width', -4],
      ['rail.width', '240'],
      ['columns.widths', { title: 'wide' }],
      ['appearance', { nested: 'dark' }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await save(key, value, adaToken);
      expect(refused.status, `${key}=${JSON.stringify(value)}`).not.toBe(200);
    }
    expect(await rowsOf(ada.personId)).toStrictEqual(before);
  });

  it('MP-2-11 no audit for preferences: an applied save adds no audit event, a refused one does', async () => {
    const before = await auditCount(ada.actorId);
    expect((await save('dock.width', 500, adaToken)).status).toBe(200);
    expect(await auditCount(ada.actorId)).toBe(before);

    expect((await save('appearance', 'sepia', adaToken)).status).not.toBe(200);
    expect(await auditCount(ada.actorId)).toBe(before + 1);
  });

  it('Sol proof, criterion 19: reading own preferences adds no audit event', async () => {
    const countReads = async (): Promise<number> => {
      const [row] = await fixture.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from public.audit_events
          where actor_id = $1 and command = 'preference.read'`,
        [ada.actorId],
      );
      return Number(row?.n);
    };
    const before = await countReads();
    await read(adaToken);
    expect(await countReads()).toBe(before);
  });

  it('MP-2-11a a person holding no grant saves their own key and is refused the read', async () => {
    const bare = await enrol(fixture.db.app, fixture.business, 'Bea Bare');
    const token = await tokenFor(bare.presented.subject);
    expect((await save('appearance', 'dark', token)).status).toBe(200);
    const readAudits = async (): Promise<number> => {
      const [row] = await fixture.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from public.audit_events
          where actor_id = $1 and command = 'preference.read' and outcome = 'refused'`,
        [bare.actorId],
      );
      return Number(row?.n);
    };
    // A refused read is audited: only a successful one is not (CS-2.8).
    expect((await call('preference.read', {}, token)).body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await readAudits()).toBe(1);
    expect(await rowsOf(bare.personId)).toStrictEqual([{ key: 'appearance', value: 'dark' }]);
  });

  it('MP-2-11a an agent under a live delegation reads and saves nothing, not even for its principal', async () => {
    const task = await c.createTask('work an agent holds while its principal has preferences');
    const reservationId = await c.approve(await c.propose(task.id, task.revision, 'pref_probe'));
    const credential = String((await c.pickup(reservationId))['credential']);
    const principal = c.manager.personId;
    const before = await rowsOf(principal);

    const saved = await c.asAgent(
      'preference.save',
      { operationId: randomUUID(), preference: 'appearance', value: 'dark' },
      credential,
    );
    const looked = await c.asAgent('preference.read', {}, credential);
    for (const answer of [saved, looked]) {
      expect(answer.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
      expectNoCanary(answer);
    }
    expect(await rowsOf(principal)).toStrictEqual(before);
  });

  it('MP-2-11a an external party (no membership) is refused, as every write but a client comment is', async () => {
    const outsider = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // A mapped person with no membership (R4): no role key.
      const personId = await insertPerson(tx, 'Olive Outside');
      const actorId = await insertActor(tx, personId);
      const subject = `outside-${randomUUID()}`;
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const member = { personId, actorId, presented: { provider: 'supabase', subject } } as const;
      await grantTo(tx, member, 'read', { kind: 'party', id: randomUUID() });
      return { personId, subject };
    });
    const token = await tokenFor(outsider.subject);
    const answer = await save('appearance', 'dark', token);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await rowsOf(outsider.personId)).toStrictEqual([]);
    // Their read is their own (empty) row: another client's canary never shows.
    const own = await call('preference.read', {}, token);
    expect(own.body['preferences']).toStrictEqual({});
    expectNoCanary(own);
  });

  describe('MP-2-11a separation', () => {
    it('business to business: another business neither reads nor writes these rows', async () => {
      const bravo = await insertBusiness(fixture.db.app, 'bravo');
      await installSpine(fixture.db.app, bravo);
      const bruno = await enrol(fixture.db.app, bravo, 'Bruno Pref');
      await fixture.db.app.withBusiness(bravo, async (tx) => await grantTo(tx, bruno, 'read'));
      const brunoToken = await tokenFor(bruno.presented.subject);

      expect((await save('appearance', 'system', brunoToken)).status).not.toBe(200);
      expect(
        (
          await call(
            'preference.save',
            { operationId: randomUUID(), preference: 'appearance', value: 'system' },
            brunoToken,
            { key: 'bravo' },
          )
        ).status,
      ).toBe(200);
      expect(await read(brunoToken, 'bravo')).toStrictEqual({ appearance: 'system' });
      expect((await read(adaToken))['appearance']).toBe('dark');
      const across = await call('preference.read', {}, brunoToken);
      expect(across.status).not.toBe(200);
      expectNoCanary(across);
    });

    it('client to client: people scoped to two clients each reach only their own row', async () => {
      const onA = await enrol(fixture.db.app, fixture.business, 'Cleo Client A');
      const onB = await enrol(fixture.db.app, fixture.business, 'Cy Client B');
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await grantTo(tx, onA, 'read', { kind: 'party', id: randomUUID() });
        await grantTo(tx, onB, 'read', { kind: 'party', id: randomUUID() });
      });
      const tokenA = await tokenFor(onA.presented.subject);
      const tokenB = await tokenFor(onB.presented.subject);

      expect((await save('rail.width', 200, tokenA)).status).toBe(200);
      expect((await save('rail.width', 380, tokenB)).status).toBe(200);
      expect(await read(tokenA)).toStrictEqual({ 'rail.width': 200 });
      expect(await read(tokenB)).toStrictEqual({ 'rail.width': 380 });
    });
  });
});

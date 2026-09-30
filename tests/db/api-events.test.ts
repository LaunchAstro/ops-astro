// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 error outbox, the API's half (the Vercel re-plan, section 11 step 2; the
// orchestrator's ruling STEP2-SHAPE). An API instance keeps no count and
// reaches no sink: it appends each security signal and each error to
// `ops.api_events` (migration 0047) in its own environment's database, and the
// worker's forwarder counts, alerts, forwards and clears. Asked of the migrated
// acceptance world:
// - the application group may insert the four columns and nothing else: no
//   select, update or delete, and the time is the database's own;
// - the forwarder is a role no one logs in as, owning nothing, granted select
//   and delete on the table alone;
// - a signal's scope is a keyed digest: the same scope under two keys differs,
//   and no column holds the business key, the subject or the source;
// - two instances with one key count one scope: the rows agree;
// - an error lands as its bounded event, with no planted word in any column.

import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOutboxAlerts } from '../../apps/api/alerts/outbox.ts';
import { connectOutbox } from '../../packages/core-records/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { attempt, Client } from './backup-identity.fixture.ts';

const FORWARDER = 'ops_astro_forwarder';
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

let world: World;
let app: Client;

type Row = { kind: string; scope: string; weight: number; event: unknown; at: Date };
const rows = async (): Promise<Row[]> => [
  ...(await world.db.admin.execute<Row>('select * from ops.api_events order by id')),
];
const clear = async (): Promise<void> => {
  await world.db.admin.execute('delete from ops.api_events');
};

describe.skipIf(serverUrl === undefined)(
  'S0-2 error outbox: the API appends, and only appends',
  () => {
    beforeAll(async () => {
      world = await createWorld('s2ev');
      app = new Client(world.db.appUrl);
    }, 180_000);

    afterAll(async () => {
      await app?.end();
      await world?.close();
    });

    roleCases();
    digestCases();
    errorCases();
  },
);

function outboxAlerts(key: Uint8Array) {
  const outbox = connectOutbox(world.db.appUrl, { source: 'runtime' });
  const alerts = createOutboxAlerts({ outbox, key, where: 'staging', root: process.cwd() });
  return { alerts, close: async () => await outbox.close() };
}

function roleCases() {
  it('lets the application group insert the four columns, and refuses it every read, change and removal', async () => {
    await clear();
    const insert = `insert into ops.api_events (kind, scope, weight) values ('secret-scan-failed', '', 1)`;
    expect(await attempt(app, insert)).toBe('ok');
    for (const text of [
      'select * from ops.api_events',
      'select count(*) from ops.api_events',
      'update ops.api_events set weight = 2',
      'delete from ops.api_events',
      `insert into ops.api_events (kind, at) values ('secret-scan-failed', now() - interval '1 day')`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(app, text), text).toBe('42501');
    }
  });

  it('makes the forwarder a role no one logs in as, owning nothing, granted select and delete on the table alone', async () => {
    const [role] = await world.db.admin.execute<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
      [FORWARDER],
    );
    expect(role).toStrictEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    const held = await world.db.admin.execute<{ held: string }>(
      `select format('%s.%s %s', table_schema, table_name, privilege_type) as held
         from information_schema.table_privileges where grantee = $1
       union all
       select format('%s.%s() %s', routine_schema, routine_name, privilege_type)
         from information_schema.routine_privileges where grantee = $1
       union all
       select 'owns ' || relname from pg_class where relowner = (select oid from pg_roles where rolname = $1)
       order by 1`,
      [FORWARDER],
    );
    expect(held.map((row) => row.held)).toStrictEqual([
      'ops.api_events DELETE',
      'ops.api_events SELECT',
    ]);
  });
}

function digestCases() {
  it('stores a scope as a keyed digest: two keys differ, and no column holds the key, subject or source', async () => {
    await clear();
    const subject = `person-${randomBytes(6).toString('hex')}`;
    const source = `hooks-${randomBytes(6).toString('hex')}`;
    for (const key of [KEY_A, KEY_B]) {
      const { alerts, close } = outboxAlerts(key);
      alerts.observe({ kind: 'sign-in-failed', business: 'alpha', person: subject });
      alerts.observe({ kind: 'webhook-signature-failed', business: 'alpha', source });
      // oxlint-disable-next-line no-await-in-loop
      await alerts.settled();
      // oxlint-disable-next-line no-await-in-loop
      await close();
    }
    const stored = await rows();
    expect(stored.map((row) => row.kind)).toStrictEqual([
      'sign-in-failed',
      'webhook-signature-failed',
      'sign-in-failed',
      'webhook-signature-failed',
    ]);
    expect(stored[0]?.scope).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored[0]?.scope).not.toBe(stored[2]?.scope);
    expect(stored[1]?.scope).not.toBe(stored[3]?.scope);
    // Not a bare digest a dictionary can reverse: the unkeyed hash is not stored.
    const bare = createHash('sha256')
      .update(JSON.stringify(['alpha', subject]))
      .digest('hex');
    const text = JSON.stringify(stored);
    for (const raw of [subject, source, 'alpha', bare]) {
      expect(text.includes(raw), 'a raw value in a stored column').toBe(false);
    }
  });

  it('two instances with one key count one scope together: every row carries the same digest', async () => {
    await clear();
    const one = outboxAlerts(KEY_A);
    const two = outboxAlerts(KEY_A);
    for (const [index, { alerts }] of [one, two, one, two, one].entries()) {
      alerts.observe({ kind: 'sign-in-failed', business: 'alpha', person: 'mia' });
      alerts.observe({ kind: 'export', business: 'alpha', who: 'mia', items: index + 1 });
    }
    await Promise.all([one.alerts.settled(), two.alerts.settled()]);
    await Promise.all([one.close(), two.close()]);
    const stored = await rows();
    const signIns = stored.filter((row) => row.kind === 'sign-in-failed');
    expect(signIns).toHaveLength(5);
    expect(new Set(signIns.map((row) => row.scope)).size).toBe(1);
    const exports = stored.filter((row) => row.kind === 'export');
    expect(exports.map((row) => row.weight).toSorted()).toStrictEqual([1, 2, 3, 4, 5]);
  });
}

function errorCases() {
  it('writes an error as its bounded event, the database stamping the time, with no plant in any column', async () => {
    await clear();
    const PLANT = 'QZOUTBOXQZ';
    const planted = Object.assign(new Error(`${PLANT} in the message`), {
      code: 'QZOUT',
      detail: PLANT,
      cause: new Error(PLANT),
    });
    const before = new Date(Date.now() - 60_000);
    const { alerts, close } = outboxAlerts(KEY_A);
    await alerts.fault(new postgres.PostgresError({ code: '22P02', message: PLANT } as never));
    await alerts.fault(planted);
    await alerts.settled();
    await close();
    const stored = await rows();
    expect(stored.map((row) => [row.kind, row.scope, row.weight])).toStrictEqual([
      ['error', '', 1],
      ['error', '', 1],
    ]);
    expect(stored.every((row) => row.at > before)).toBe(true);
    expect(JSON.stringify(stored).includes('QZOUT'), 'a plant in the outbox').toBe(false);
    expect(JSON.stringify(stored[1]?.event)).toContain('"level":"error"');
  });
}

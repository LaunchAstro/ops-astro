// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// MP-14-7a: the connector fleet on Connections & signal, over HTTP against a
// real database. Each case is named after the acceptance line or supporting
// checklist line it proves (U33, #490).
//
// Connection rows are written by the connector's setup (MP-13-5) and the
// broker's sync (AW-01), neither built, so the cases seed them as the
// database owner. The credential each one uses is set through custody
// (`secret.set`) with a planted canary value, and every client label carries
// a planted record canary, so the last case can look for both everywhere they
// must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { ConnectionFleetResult, ConnectionView } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const SECRET_CANARY = `secret-canary-${randomUUID()}-do-not-log`;
const RECORD_CANARY = `record-canary-${randomUUID()}`;
const BRAVO_CANARY = `bravo-canary-${randomUUID()}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const byId = (result: ConnectionFleetResult, id: string): ConnectionView | undefined =>
  result.connections.find((one) => one.id === id);

interface Seeded {
  readonly id: string;
  readonly label: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-7a connector fleet', () => {
  const pair = generateSealingPair('test/mp-14-7a@1');
  let controls: Controls;
  let admin: Member;
  let reader: Member;
  let clientReader: Member;
  let clientCustodian: Member;
  let plain: Member;
  let bravoAdmin: Member;
  let alpha: string;
  let bravo: string;
  const clientA = randomUUID();
  const clientB = randomUUID();
  const clientALabel = `Client A ${RECORD_CANARY}`;
  const clientBLabel = `Client B ${RECORD_CANARY}`;
  let linkedin: Seeded;
  let xero: Seeded;
  let ga4: Seeded;
  let onlyB: Seeded;
  let bravoConnection: Seeded;
  let secretId: string;
  const answers: Answer[] = [];
  const output: string[] = [];
  const fetchSpy = vi.fn();

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

  const fleet = async (who: Member, business = 'alpha'): Promise<ConnectionFleetResult> => {
    const answer = await as(who, 'connection.fleet', {}, business);
    expect(answer.status).toBe(200);
    return answer.body as unknown as ConnectionFleetResult;
  };

  const repair = async (
    who: Member,
    connectionId: string,
    extra: Readonly<Record<string, unknown>> = {},
    business = 'alpha',
  ): Promise<Answer> => await as(who, 'connector.repair', { connectionId, ...extra }, business);

  const repairRows = async (): Promise<number> =>
    await controls.count('select count(*) as n from public.connection_repairs', []);

  async function seed(
    business: string,
    row: {
      readonly label: string;
      readonly status: 'active' | 'degraded' | 'broken';
      readonly failure?: string;
      readonly clients: readonly (readonly [string, string])[];
      readonly secret?: string;
      readonly syncedHoursAgo?: number | null;
      readonly cadenceMinutes?: number;
    },
  ): Promise<Seeded> {
    const id = randomUUID();
    const { db } = controls.fixture;
    const synced = row.syncedHoursAgo ?? null;
    await db.admin.execute(
      `insert into public.connections
         (business_id, id, connector_key, label, auth_method, status, failure_class,
          cadence_minutes, last_synced_at, last_attempt_at, scope, read_components,
          execute_components, secret_id)
       values ($1, $2, 'linkedin', $3, 'OAuth 2.0', $4, $5, $6,
               case when $7::numeric is null then null else now() - make_interval(hours => $7::int) end,
               now() - interval '5 minutes', 'r_ads r_organization', $8, $9, $10)`,
      [
        business,
        id,
        row.label,
        row.status,
        row.status === 'active' ? null : (row.failure ?? 'auth_expired'),
        row.cadenceMinutes ?? 1440,
        synced,
        ['campaigns', 'spend'],
        row.status === 'broken' ? ['budgets'] : [],
        row.secret ?? null,
      ],
    );
    for (const [clientId, clientLabel] of row.clients) {
      // eslint-disable-next-line no-await-in-loop -- a handful of rows in order
      await db.admin.execute(
        `insert into public.connection_clients (business_id, connection_id, client_id, client_label)
         values ($1, $2, $3, $4)`,
        [business, id, clientId, clientLabel],
      );
    }
    return { id, label: row.label };
  }

  // eslint-disable-next-line max-lines-per-function -- the world, built in one place
  beforeAll(async () => {
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
    // Nothing in this ticket may send a request anywhere. The spy answers
    // nothing and records every attempt, so the gate case can count them.
    vi.stubGlobal('fetch', fetchSpy);

    controls = await createControls('mp147a', { custody: pair.key });
    const { db, business } = controls.fixture;
    alpha = business;
    admin = controls.manager;
    reader = await enrol(db.app, business, 'reader');
    clientReader = await enrol(db.app, business, 'clientreader');
    clientCustodian = await enrol(db.app, business, 'clientcustodian');
    plain = await enrol(db.app, business, 'plain');
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'manage', whole, false, 'custody');
      await grantTo(tx, admin, 'read', whole, false, 'connection');
      await grantTo(tx, reader, 'read', whole, false, 'connection');
      await grantTo(tx, reader, 'read', whole, false, 'custody');
      await grantTo(tx, reader, 'write', whole, false, 'custody');
      await grantTo(tx, clientReader, 'read', { kind: 'party', id: clientA }, false, 'connection');
      await grantTo(tx, clientCustodian, 'read', whole, false, 'connection');
      await grantTo(
        tx,
        clientCustodian,
        'manage',
        { kind: 'party', id: clientA },
        false,
        'custody',
      );
      await grantTo(tx, plain, 'read', whole, false, 'task');
    });
    const set = await as(admin, 'secret.set', { name: 'linkedin.token', value: SECRET_CANARY });
    secretId = String((set.body['detail'] as Record<string, unknown>)['secretId']);

    linkedin = await seed(alpha, {
      label: 'LinkedIn Ads',
      status: 'broken',
      failure: 'auth_expired',
      clients: [
        [clientA, clientALabel],
        [clientB, clientBLabel],
      ],
      secret: secretId,
      syncedHoursAgo: 200,
    });
    xero = await seed(alpha, {
      label: 'Xero',
      status: 'broken',
      failure: 'auth_revoked',
      clients: [[clientA, clientALabel]],
      syncedHoursAgo: null,
    });
    ga4 = await seed(alpha, {
      label: 'GA4',
      status: 'active',
      clients: [[clientA, clientALabel]],
      syncedHoursAgo: 2,
    });
    onlyB = await seed(alpha, {
      label: `Meta Ads ${RECORD_CANARY}`,
      status: 'degraded',
      failure: 'throttled',
      clients: [[clientB, clientBLabel]],
      syncedHoursAgo: 30,
    });

    const other = await insertBusiness(db.app, 'bravo');
    bravo = other;
    await installSpine(db.app, other);
    bravoAdmin = await enrol(db.app, other, 'bravoadmin');
    await db.app.withBusiness(other, async (tx) => {
      await grantTo(tx, bravoAdmin, 'manage', whole, false, 'custody');
      await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
    });
    bravoConnection = await seed(other, {
      label: `Bravo source ${BRAVO_CANARY}`,
      status: 'broken',
      clients: [[randomUUID(), `Bravo client ${BRAVO_CANARY}`]],
      syncedHoursAgo: 50,
    });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await controls?.drop();
  });

  it('MP-14-7a owner check: every connector shows its status and clients, and a broken one can be repaired', async () => {
    const result = await fleet(admin);
    expect(result.connections.map((one) => one.label).toSorted()).toStrictEqual(
      [linkedin.label, xero.label, ga4.label, onlyB.label].toSorted(),
    );
    const shown = byId(result, linkedin.id);
    expect(shown?.status).toBe('broken');
    expect(shown?.failureClass).toBe('auth_expired');
    expect(shown?.clients.map((one) => one.id).toSorted()).toStrictEqual(
      [clientA, clientB].toSorted(),
    );
    const started = await repair(admin, linkedin.id);
    expect(started.status).toBe(200);
    expect((started.body['detail'] as Record<string, unknown>)['state']).toBe('awaiting approval');
    expect(byId(await fleet(admin), linkedin.id)?.repairStartedAt).not.toBeNull();
  });

  it('MP-14-7a client lists and scopes come from real connection records', async () => {
    const before = byId(await fleet(admin), ga4.id);
    expect(before?.clients).toStrictEqual([{ id: clientA, label: clientALabel }]);
    expect(before?.scope).toBe('r_ads r_organization');
    expect(before?.readComponents).toStrictEqual(['campaigns', 'spend']);
    const added = randomUUID();
    await controls.fixture.db.admin.execute(
      `insert into public.connection_clients (business_id, connection_id, client_id, client_label)
       values ($1, $2, $3, 'Added client')`,
      [alpha, ga4.id, added],
    );
    const after = byId(await fleet(admin), ga4.id);
    expect(after?.clients.map((one) => one.id)).toContain(added);
    await controls.fixture.db.admin.execute(
      `delete from public.connection_clients where connection_id = $1 and client_id = $2`,
      [ga4.id, added],
    );
  });

  it('MP-14-7a the banner and counts agree with the rows', async () => {
    for (const who of [admin, clientReader]) {
      // eslint-disable-next-line no-await-in-loop -- one reader at a time
      const result = await fleet(who);
      const rows = result.connections;
      expect(result.counts).toStrictEqual({
        all: rows.length,
        active: rows.filter((one) => one.status === 'active').length,
        degraded: rows.filter((one) => one.status === 'degraded').length,
        broken: rows.filter((one) => one.status === 'broken').length,
        clientConnections: rows.reduce((sum, one) => sum + one.clients.length, 0),
      });
    }
    expect((await fleet(admin)).counts.broken).toBe(2);
  });

  it('MP-14-7a credential custody is a reference: the secret id and set or not set', async () => {
    const result = await fleet(admin);
    expect(byId(result, linkedin.id)?.custody).toStrictEqual({ secretId, state: 'set' });
    expect(byId(result, xero.id)?.custody).toStrictEqual({ secretId: null, state: 'not set' });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it('MP-14-7a every change is recorded: connector repair started joins the audit chain', async () => {
    const answer = await repair(admin, xero.id);
    expect(answer.status).toBe(200);
    const repairId = String((answer.body['detail'] as Record<string, unknown>)['repairId']);
    const rows = await controls.fixture.db.admin.execute<{
      readonly connection_id: string;
      readonly connection_revision: string;
      readonly started_by_actor_id: string;
    }>(
      `select connection_id, connection_revision, started_by_actor_id
         from public.connection_repairs where id = $1`,
      [repairId],
    );
    expect(rows[0]).toStrictEqual({
      connection_id: xero.id,
      connection_revision: '1',
      started_by_actor_id: admin.actorId,
    });
    const events = await controls.fixture.db.admin.execute<{
      readonly outcome: string;
      readonly hash: string;
    }>(
      `select outcome, hash from public.audit_events
        where actor_id = $1 and command = 'connector.repair' and outcome = 'applied'`,
      [admin.actorId],
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('MP-14-7a the fleet read writes no repair and no audit event beyond its own operation row', async () => {
    const count = async (): Promise<number> =>
      await controls.count(`select count(*) as n from public.audit_events where actor_id = $1`, [
        reader.actorId,
      ]);
    const before = await count();
    const repairsBefore = await repairRows();
    await fleet(reader);
    expect(await count()).toBe(before + 1);
    const last = await controls.fixture.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events where actor_id = $1 order by seq desc limit 1`,
      [reader.actorId],
    );
    expect(last[0]?.command).toBe('connection.fleet');
    expect(await repairRows()).toBe(repairsBefore);
  });

  it('MP-14-7a refusal connection:read: a member without it is refused the fleet', async () => {
    const answer = await as(plain, 'connection.fleet', {});
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer.body['connections']).toBeUndefined();
  });

  it('MP-14-7a refusal custody:manage: read and write holders and a client-scoped holder cannot start a repair', async () => {
    const before = await repairRows();
    for (const who of [reader, clientCustodian, plain]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const answer = await repair(who, linkedin.id);
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await repairRows()).toBe(before);
  });

  it('MP-14-7a refusal: an agent under a live delegation reads no fleet and starts no repair', async () => {
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const reservationId = await controls.approve(proposal);
    const picked = await controls.pickup(reservationId);
    const credential = String(picked['credential']);
    const before = await repairRows();
    for (const [name, body] of [
      ['connection.fleet', {}],
      ['connector.repair', { connectionId: linkedin.id }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await controls.asAgent(name, body, credential);
      answers.push(answer);
      expect(answer.status).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
      expect(answer.body['connections']).toBeUndefined();
    }
    expect(await repairRows()).toBe(before);
  });

  it('MP-14-7a isolation: another business never sees, counts or repairs these connections', async () => {
    const theirs = await fleet(bravoAdmin, 'bravo');
    expect(theirs.connections.map((one) => one.id)).toStrictEqual([bravoConnection.id]);
    expect(theirs.counts.all).toBe(1);
    const text = JSON.stringify(theirs);
    for (const mine of [linkedin, xero, ga4, onlyB]) expect(text).not.toContain(mine.id);
    expect(text).not.toContain(RECORD_CANARY);

    const before = await repairRows();
    const foreign = await repair(bravoAdmin, xero.id, {}, 'bravo');
    expect(foreign.status).toBe(404);
    expect(foreign.body['code']).toBe('NOT_FOUND');
    const fabricated = await repair(bravoAdmin, randomUUID(), {}, 'bravo');
    const malformed = await repair(bravoAdmin, 'not-a-uuid', {}, 'bravo');
    for (const other of [fabricated, malformed]) {
      expect(other.status).toBe(foreign.status);
      expect(other.body).toStrictEqual(foreign.body);
    }
    expect(await repairRows()).toBe(before);

    const ours = await fleet(admin);
    expect(JSON.stringify(ours)).not.toContain(BRAVO_CANARY);
    expect(JSON.stringify(ours)).not.toContain(bravoConnection.id);
    expect(bravo).not.toBe(alpha);
  });

  it('MP-14-7a isolation: a client-scoped reader sees that client only, in rows, lists and counts', async () => {
    const result = await fleet(clientReader);
    expect(result.connections.map((one) => one.id).toSorted()).toStrictEqual(
      [linkedin.id, xero.id, ga4.id].toSorted(),
    );
    for (const one of result.connections) {
      expect(one.clients).toStrictEqual([{ id: clientA, label: clientALabel }]);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain(clientB);
    expect(text).not.toContain(clientBLabel);
    expect(text).not.toContain(onlyB.id);
    expect(result.counts).toStrictEqual({
      all: 3,
      active: 1,
      degraded: 0,
      broken: 2,
      clientConnections: 3,
    });
    const repairing = await repair(clientReader, onlyB.id);
    expect(repairing.status).toBe(403);
    expect(JSON.stringify(repairing.body)).not.toContain(onlyB.label);
  });

  it('MP-14-7a a repair is only for a broken connection', async () => {
    const before = await repairRows();
    const answer = await repair(admin, ga4.id);
    expect(answer.status).toBe(409);
    expect(answer.body['code']).toBe('TRANSITION_NOT_PERMITTED');
    expect(await repairRows()).toBe(before);
  });

  it('MP-14-7a a stale revision is refused and starts nothing', async () => {
    const before = await repairRows();
    const answer = await repair(admin, linkedin.id, { expectedRevision: 7 });
    expect(answer.status).toBe(409);
    expect(answer.body['code']).toBe('VERSION_STALE');
    const bad = await repair(admin, linkedin.id, { expectedRevision: 'one' });
    expect(bad.status).toBe(422);
    expect(bad.body['code']).toBe('FIELD_VALUE_INVALID');
    expect(await repairRows()).toBe(before);
  });

  it('MP-14-7a two repairs at once on one revision are one repair', async () => {
    const fresh = await seed(alpha, {
      label: 'Race source',
      status: 'broken',
      clients: [[clientA, clientALabel]],
    });
    const [one, two] = await Promise.all([repair(admin, fresh.id), repair(admin, fresh.id)]);
    expect([one.status, two.status]).toStrictEqual([200, 200]);
    const ids = [one, two].map((answer) =>
      String((answer.body['detail'] as Record<string, unknown>)['repairId']),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(
      await controls.count(
        'select count(*) as n from public.connection_repairs where connection_id = $1',
        [fresh.id],
      ),
    ).toBe(1);
  });

  it('MP-14-7a nothing leaves before the approval gate: a started repair sends nothing and uses no credential', async () => {
    const usedBefore = await controls.fixture.db.admin.execute<{
      readonly last_used_at: Date | null;
    }>(`select last_used_at from public.custody_secrets where id = $1`, [secretId]);
    const calls = fetchSpy.mock.calls.length;
    const answer = await repair(admin, linkedin.id);
    expect(answer.status).toBe(200);
    expect(fetchSpy.mock.calls.length).toBe(calls);
    const usedAfter = await controls.fixture.db.admin.execute<{
      readonly last_used_at: Date | null;
    }>(`select last_used_at from public.custody_secrets where id = $1`, [secretId]);
    expect(usedAfter[0]?.last_used_at).toStrictEqual(usedBefore[0]?.last_used_at);
    const shown = byId(await fleet(admin), linkedin.id);
    expect(shown?.status).toBe('broken');
    expect(shown?.revision).toBe(1);
    // The repair names that exact version: once the connection moves on, it
    // no longer shows as started, and a repair must be started again.
    await controls.fixture.db.admin.execute(
      `update public.connections set revision = revision + 1 where id = $1`,
      [linkedin.id],
    );
    expect(byId(await fleet(admin), linkedin.id)?.repairStartedAt).toBeNull();
  });

  it('MP-14-7a parity: the fleet is connection:read and the repair custody:manage, person only', () => {
    const fleetRow = COMMAND_SURFACE.find((one) => one.name === 'connection.fleet');
    expect([fleetRow?.collection, fleetRow?.action, fleetRow?.agent]).toStrictEqual([
      'connection',
      'read',
      'never',
    ]);
    const repairRow = COMMAND_SURFACE.find((one) => one.name === 'connector.repair');
    expect([repairRow?.collection, repairRow?.action, repairRow?.agent]).toStrictEqual([
      'custody',
      'manage',
      'never',
    ]);
  });

  it('MP-14-7a canary: the planted secret and record content never reach output, errors or the audit payload', async () => {
    const { db } = controls.fixture;
    for (const answer of answers) {
      expect(JSON.stringify(answer.body)).not.toContain(SECRET_CANARY);
      if (answer.status !== 200) expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
    const printed = output.join('\n');
    for (const canary of [SECRET_CANARY, RECORD_CANARY, BRAVO_CANARY]) {
      expect(printed).not.toContain(canary);
    }
    const audit = await db.admin.execute<{ readonly dump: string | null }>(
      `select string_agg(t::text, E'\\n') as dump from public.audit_events t`,
    );
    for (const canary of [SECRET_CANARY, RECORD_CANARY, BRAVO_CANARY]) {
      expect(audit[0]?.dump ?? '').not.toContain(canary);
    }
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
    expect(dumps.join('\n')).not.toContain(SECRET_CANARY);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-lines -- failure-path proofs share one migrated database fixture
//
// S0-2 error outbox, the forwarder's half (the Vercel re-plan, section 11 step
// 2; ruling STEP2-SHAPE), and S0-2 heartbeats. The forwarder (`apps/forwarder`)
// takes `ops_astro_forwarder` in its own transaction, counts what the API
// instances appended under the detector's rules, raises the alert, sends each
// error rebuilt from its allowlist, deletes what it sent or counted into an
// alert and pings its heartbeat. Asked of a fresh API fixture, two function entries as instances:
// refusals over two instances raise one alert and one person's never bring
// another's closer; business, client and delegate count apart; a planted
// class, text or frame never reaches the sink; a failing sink keeps the rows
// and pings nothing; rows past the window are dropped with one alert; the
// login alone reads nothing.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOutboxAlerts } from '../../apps/api/alerts/outbox.ts';
import type { SinkEvent } from '../../apps/api/alerts/sink.ts';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import {
  connectAsAdmin,
  connectOutbox,
  type AdminConnection,
} from '../../packages/core-records/src/index.ts';
import { serveTestKeySet, type ServedKeySet } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  ISSUER,
  tokenFor,
  type ApiFixture,
} from '../api/fixture.ts';
import { asRole, attempt, Client, loginIn } from './backup-identity.fixture.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FORWARDER = 'ops_astro_forwarder';
const HOST = 'ops.example.test';
const KEY = randomBytes(32);
const CANARY = `fwd-canary-${randomBytes(6).toString('hex')}`;
const KEY_ID = 'test/forwarder@1';
const frame = (filename: string) => ({ filename, lineno: 7, in_app: true });

let fixture: ApiFixture;
let keySet: ServedKeySet;
let logins: { url: string; name: string }[] = [];
let forwarderDb: AdminConnection;

const count = async (): Promise<number> => {
  const [row] = await fixture.db.admin.execute<{ n: number }>(
    'select count(*)::int as n from ops.api_events',
  );
  return row?.n ?? -1;
};
const clear = async (): Promise<void> => {
  await fixture.db.admin.execute('delete from ops.api_events');
  await fixture.db.admin.execute('delete from ops.api_alerts');
};
/** An instance appends after it answers: wait for the rows it owes. */
const rowsReach = async (n: number): Promise<void> =>
  await vi.waitFor(async () => expect(await count()).toBe(n), { timeout: 5000, interval: 50 });

function sink(down = false) {
  const events: SinkEvent[] = [];
  return {
    events,
    send: (event: SinkEvent): Promise<void> =>
      down
        ? Promise.reject(new Error('the sink is down'))
        : Promise.resolve(void events.push(event)),
    alerts: (): string[] =>
      events.filter((event) => event.level === 'warning').map((event) => event.tags['alert'] ?? ''),
  };
}

function latch() {
  let complete!: () => void;
  const promise = new Promise<void>((done) => { complete = done; });
  return { promise, open: () => complete() };
}

function forwarder(to: ReturnType<typeof sink>, pings: string[] = []) {
  return createForwarder({
    database: forwarderDb,
    send: to.send,
    where: 'staging',
    root: ROOT,
    heartbeat: () => Promise.resolve(void pings.push('sent')),
  });
}

function instance() {
  return createFunctionHandler({
    ...fixture.environment,
    DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
    DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
    DATABASE_URL: fixture.db.appUrl,
    DATABASE_LOOKUP_URL: logins[0]?.url,
    GOTRUE_URL: ISSUER,
    SUPABASE_KEY_SET_URL: keySet.url,
    SERVED_HOST: HOST,
    OPS_ENVIRONMENT: 'staging',
    ALERT_SCOPE_KEY: KEY.toString('hex'),
  });
}

function board(token: string): Request {
  return new Request(`https://${HOST}${PREFIX.person}${BUSINESS_KEY}/task/board`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', ...authorised(token) },
    body: '{"board":null}',
  });
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'S0-2 error outbox: the forwarder counts, forwards, clears and pings',
  () => {
    beforeAll(async () => {
      fixture = await createApiFixture('s2fw');
      keySet = await serveTestKeySet();
      logins = [
        await loginIn(fixture.db, 'ops_astro_lookup', 'lk'),
        await loginIn(fixture.db, FORWARDER, 'fw'),
      ];
      forwarderDb = connectAsAdmin(logins[1]?.url ?? '', { source: 'forwarder' });
    }, 60_000);

    afterAll(async () => {
      await forwarderDb?.close();
      await keySet?.close();
      await fixture?.drop();
      const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
      const drops = logins.map(({ name }) => cleanup.query(`drop role if exists "${name}"`));
      await Promise.all(drops).finally(() => cleanup.end());
    });

    instanceCases();
    isolationCases();
    errorCases();
    lockCases();
    heartbeatCases();
    retentionCases();
    loginCases();
    deliveryHeartbeatCases();
    deliveryAlertCases();
    deliveryErrorCases();
    acceptedAlertCase();
    outOfOrderSignalCase();
    inFlightSignalCase();
    missingHeartbeatCase();
    lateCommitAlertRetryCase();
  },
);

function instanceCases() {
  it('counts across instances: refusals over two function instances raise one alert, per person', async () => {
    await clear();
    const [a, b] = [instance(), instance()] as const;
    // Signed in, and in no business here: each refusal is a cross-scope one.
    const mia = await tokenFor(`mia-${randomBytes(4).toString('hex')}`);
    const noah = await tokenFor(`noah-${randomBytes(4).toString('hex')}`);
    for (let i = 0; i < 9; i += 1) {
      const [first, second] = i % 2 === 0 ? [a, b] : [b, a];
      // oxlint-disable-next-line no-await-in-loop -- each refusal in turn
      expect((await first(board(mia))).status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await second(board(noah))).status).toBe(403);
    }
    await rowsReach(18);
    const to = sink();
    const forward = forwarder(to);
    await forward.once();
    expect(to.alerts()).toEqual([]);
    // The count is the table's: rows under their threshold stay for the next pass.
    expect(await count()).toBe(18);
    expect((await b(board(mia))).status).toBe(403);
    await rowsReach(19);
    await forward.once();
    expect(to.alerts()).toEqual(['cross-scope-burst']);
    // Mia's ten went with her alert; Noah's nine wait inside their window.
    expect(await count()).toBe(9);
  });
}

function deliveryHeartbeatCases() {
  it('reports a failed heartbeat instead of completing a pass successfully', async () => {
    await clear();
    const forward = createForwarder({
      database: forwarderDb,
      send: sink().send,
      where: 'staging',
      root: ROOT,
      heartbeat: () => Promise.resolve('failed'),
    });
    await expect(forward.once()).rejects.toThrow('heartbeat');
  });

}

function deliveryAlertCases() {
  it('retries an alert after its sink call fails and the forwarder restarts', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    for (let i = 0; i < 10; i += 1) {
      alerts.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
    }
    await alerts.settled();
    await outbox.close();
    await expect(forwarder(sink(true)).once()).rejects.toThrow('the sink is down');
    const afterRestart = sink();
    await forwarder(afterRestart).once();
    expect(afterRestart.alerts()).toEqual(['cross-scope-burst']);
  });

  it('counts a threshold across two forwarder processes', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    const first = sink();
    const second = sink();
    const a = forwarder(first);
    const b = forwarder(second);
    for (let i = 0; i < 9; i += 1) {
      alerts.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
    }
    await alerts.settled();
    await a.once();
    alerts.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
    await alerts.settled();
    await b.once();
    expect([...first.alerts(), ...second.alerts()]).toEqual(['cross-scope-burst']);
    await outbox.close();
  });

}

function deliveryErrorCases() {
  it('reuses the delivery id after an accepted error loses its sink response', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    await alerts.fault(new TypeError(CANARY));
    await outbox.close();
    const accepted = new Map<string, SinkEvent>();
    const lostResponse = createForwarder({
      database: forwarderDb,
      send: (event) => {
        accepted.set(event.event_id, event);
        return Promise.reject(new Error('response lost after acceptance'));
      },
      where: 'staging',
      root: ROOT,
    });
    await expect(lostResponse.once()).rejects.toThrow('response lost after acceptance');
    expect(await count()).toBe(1);
    const retry = createForwarder({
      database: forwarderDb,
      send: (event) => Promise.resolve(void accepted.set(event.event_id, event)),
      where: 'staging',
      root: ROOT,
    });
    await retry.once();
    expect(accepted.size).toBe(1);
  });
}

function acceptedAlertCase() {
  it('reuses the delivery id when an accepted alert loses its sink response', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    for (let i = 0; i < 10; i += 1) {
      alerts.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
    }
    await alerts.settled();
    await outbox.close();
    const accepted = new Set<string>();
    const lostResponse = createForwarder({
      database: forwarderDb,
      send: (event) => {
        accepted.add(event.event_id);
        return Promise.reject(new Error('response lost after alert acceptance'));
      },
      where: 'staging',
      root: ROOT,
    });
    await expect(lostResponse.once()).rejects.toThrow('response lost after alert acceptance');
    const retry = createForwarder({
      database: forwarderDb,
      send: (event) => Promise.resolve(void accepted.add(event.event_id)),
      where: 'staging',
      root: ROOT,
    });
    await retry.once();
    expect(accepted.size).toBe(1);
  });
}

function outOfOrderSignalCase() {
  it('clears every signal counted into a burst when timestamps arrive out of id order', async () => {
    await clear();
    const scope = 'ab'.repeat(32);
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each insert gets the next identity value
      await fixture.db.admin.execute(
        `insert into ops.api_events (kind, scope, at)
           values ('cross-scope-refusal', $1, now() - make_interval(secs => $2))`,
        [scope, i],
      );
    }
    const to = sink();
    await forwarder(to).once();
    expect(to.alerts()).toEqual(['cross-scope-burst']);
    expect(await count()).toBe(0);
  });
}

function inFlightSignalCase() {
  it('keeps a signal that commits after replay and before burst deletion', async () => {
    await clear();
    const scope = 'ab'.repeat(32);
    const gate = latch();
    const ready = latch();
    const held = fixture.db.admin.transaction(async (execute) => {
      await execute(
        `insert into ops.api_events (kind, scope) values ('cross-scope-refusal', $1)`,
        [scope],
      );
      ready.open();
      await gate.promise;
    });
    await ready.promise;
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each insert is committed before replay
      await outbox.append({
        kind: 'cross-scope-refusal', scope, weight: 1,
      });
    }
    await outbox.close();
    const to = sink();
    const forward = createForwarder({
      database: forwarderDb,
      send: (event) => {
        gate.open();
        return held.then(() => void to.events.push(event));
      },
      where: 'staging', root: ROOT,
    });
    try {
      await forward.once();
      expect(to.alerts()).toEqual(['cross-scope-burst']);
      expect(await count()).toBe(1);
    } finally {
      gate.open();
      await held;
    }
  });
}

function missingHeartbeatCase() {
  it('refuses a completed pass when its watcher heartbeat is not set', async () => {
    await clear();
    const forward = createForwarder({
      database: forwarderDb,
      send: sink().send,
      where: 'staging',
      root: ROOT,
      heartbeat: () => Promise.resolve('not set'),
    });
    await expect(forward.once()).rejects.toThrow('heartbeat');
  });
}

function lateCommitAlertRetryCase() {
  it('reuses an accepted alert id when an earlier signal commits before retry', async () => {
    await clear();
    const scope = 'ab'.repeat(32);
    const gate = latch();
    const ready = latch();
    const held = fixture.db.admin.transaction(async (execute) => {
      await execute(
        `insert into ops.api_events (kind, scope) values ('cross-scope-refusal', $1)`,
        [scope],
      );
      ready.open();
      await gate.promise;
    });
    await ready.promise;
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- ten committed signals follow the held one
      await outbox.append({ kind: 'cross-scope-refusal', scope, weight: 1 });
    }
    await outbox.close();
    const accepted = new Set<string>();
    const first = createForwarder({
      database: forwarderDb,
      send: async (event) => {
        accepted.add(event.event_id);
        gate.open();
        await held;
        throw new Error('response lost after alert acceptance');
      },
      where: 'staging', root: ROOT,
    });
    try {
      await expect(first.once()).rejects.toThrow('response lost after alert acceptance');
      const retry = createForwarder({
        database: forwarderDb,
        send: (event) => Promise.resolve(void accepted.add(event.event_id)),
        where: 'staging', root: ROOT,
      });
      await retry.once();
      expect(accepted.size).toBe(1);
    } finally {
      gate.open();
      await held;
    }
  });
}

function isolationCases() {
  it('S0-2 isolation through the outbox: business, client, and a delegate apart from its person', async () => {
    await clear();
    const outboxes = [0, 1].map(() => connectOutbox(fixture.db.appUrl, { source: 'runtime' }));
    const [one, two] = outboxes.map((outbox) =>
      createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT }),
    );
    if (one === undefined || two === undefined) throw new Error('two instances');
    for (let i = 0; i < 9; i += 1) {
      if (i < 4) one.observe({ kind: 'sign-in-failed', business: 'alpha', person: CANARY });
      if (i < 4) two.observe({ kind: 'sign-in-failed', business: 'beta', person: CANARY });
      one.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
      two.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'agent-for-mia' });
    }
    one.observe({ kind: 'export', business: 'alpha', who: 'c1', items: 3000 });
    two.observe({ kind: 'export', business: 'alpha', who: 'c2', items: 3000 });
    two.observe({ kind: 'export', business: 'beta', who: 'c1', items: 3000 });
    await Promise.all([one.settled(), two.settled()]);
    const to = sink();
    const forward = forwarder(to);
    await forward.once();
    expect(to.alerts()).toEqual([]);
    two.observe({ kind: 'sign-in-failed', business: 'alpha', person: CANARY });
    one.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'agent-for-mia' });
    two.observe({ kind: 'export', business: 'alpha', who: 'c1', items: 2000 });
    await Promise.all([one.settled(), two.settled()]);
    await forward.once();
    expect(to.alerts().toSorted()).toEqual([
      'cross-scope-burst',
      'export-volume',
      'sign-in-failures',
    ]);
    const sent = JSON.stringify(to.events.map(({ message, tags }) => ({ message, tags })));
    for (const name of [CANARY, 'alpha', 'beta', 'mia', 'c1', 'c2']) {
      expect(sent.includes(name), 'a scope name').toBe(false);
    }
    await Promise.all(outboxes.map(async (outbox) => await outbox.close()));
  });
}

function errorCases() {
  it('forwards an error as its bounded event: a planted class, text or frame never reaches the sink', async () => {
    await clear();
    const frames = ['apps/api/function.ts', `apps/${CANARY}.ts`, '../../../etc/hosts'].map((name) =>
      frame(name),
    );
    const thrown = { type: `Custom${CANARY}`, value: CANARY, stacktrace: { frames } };
    const planted = {
      environment: 'production',
      release: 'aaaaaaaaaaaa',
      message: { formatted: CANARY },
      tags: { alert: 'app-error', planted: CANARY },
      exception: { values: [thrown] },
    };
    await fixture.db.admin.execute(
      `insert into ops.api_events (kind, event) values ('error', $1::text::jsonb)`,
      [JSON.stringify(planted)],
    );
    const to = sink();
    expect(await forwarder(to).once()).toEqual({ handled: 1, dropped: 0 });
    expect(to.events).toHaveLength(1);
    const [event] = to.events;
    expect(event?.environment).toBe('staging');
    // The row's release is the app's to write: the forwarder sends its own stamp or none.
    expect(event?.release).toBeUndefined();
    expect(event?.tags).toEqual({ alert: 'app-error' });
    expect(event?.exception?.values[0]?.type).toBe('Error');
    expect(event?.exception?.values[0]?.stacktrace.frames).toEqual([frame('apps/api/function.ts')]);
    expect(JSON.stringify(event)).not.toContain(CANARY);
    expect(await count()).toBe(0);
  });
}

function heartbeatCases() {
  it('S0-2 heartbeats: a pass whose sink fails keeps the rows and pings nothing; the next one pings', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    await alerts.fault(new TypeError(CANARY));
    await outbox.close();
    const pings: string[] = [];
    await expect(forwarder(sink(true), pings).once()).rejects.toThrow();
    expect(await count()).toBe(1);
    expect(pings).toEqual([]);
    const to = sink();
    await forwarder(to, pings).once();
    expect(pings).toEqual(['sent']);
    expect(to.events.map((event) => event.exception?.values[0]?.type)).toEqual(['TypeError']);
    expect(JSON.stringify(to.events)).not.toContain(CANARY);
    expect(await count()).toBe(0);
  });
}

function retentionCases() {
  it('drops rows older than the window uncounted, with one signals-dropped alert', async () => {
    await clear();
    const scope = 'ab'.repeat(32);
    await fixture.db.admin.execute(
      `insert into ops.api_events (kind, scope, at)
         select 'sign-in-failed', $1, now() - interval '2 hours' from generate_series(1, 6)`,
      [scope],
    );
    await fixture.db.admin.execute(
      `insert into ops.api_events (kind, scope) values ('sign-in-failed', $1)`,
      [scope],
    );
    const to = sink();
    expect(await forwarder(to).once()).toEqual({ handled: 1, dropped: 6 });
    expect(to.alerts()).toEqual(['signals-dropped']);
    expect(await count()).toBe(1);
  });
}

function loginCases() {
  it('the forwarder login alone reads nothing; as the role it reads the outbox and nothing else', async () => {
    const url = logins[1]?.url ?? '';
    const bare = new Client(url);
    const role = await asRole(url, FORWARDER);
    try {
      expect(await attempt(bare, 'select * from ops.api_events')).toBe('42501');
      expect(await attempt(role, 'select * from ops.api_events')).toBe('ok');
      expect(await attempt(role, 'select * from public.businesses')).toBe('42501');
      expect(
        await attempt(role, `insert into ops.api_events (kind) values ('secret-scan-failed')`),
      ).toBe('42501');
    } finally {
      await bare.end();
      await role.end();
    }
  });
}

function lockCases() {
  it('two forwarder passes at once count one burst once: the pass lock serialises them', async () => {
    await clear();
    const outbox = connectOutbox(fixture.db.appUrl, { source: 'runtime' });
    const alerts = createOutboxAlerts({ outbox, key: KEY, where: 'staging', root: ROOT });
    for (let i = 0; i < 10; i += 1) {
      alerts.observe({ kind: 'cross-scope-refusal', business: 'alpha', person: 'mia' });
    }
    await alerts.settled();
    await outbox.close();
    const [first, second] = [sink(), sink()];
    const other = connectAsAdmin(logins[1]?.url ?? '', { source: 'forwarder' });
    const b = createForwarder({ database: other, send: second.send, where: 'staging', root: ROOT });
    await Promise.all([forwarder(first).once(), b.once()]).finally(() => other.close());
    expect([...first.alerts(), ...second.alerts()]).toEqual(['cross-scope-burst']);
    expect(await count()).toBe(0);
  });
}

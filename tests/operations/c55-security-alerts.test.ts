// SPDX-License-Identifier: AGPL-3.0-only
//
// C55 (TR-SEC-9; ruling ORCH47 (b)6): the operations view lists the security
// alerts S0-2 raises, each with its time and what it concerns, never its id,
// secret or record content, through the real API and the real forwarder.
//
// The forwarder deletes an alert from `ops.api_alerts` once the sink took it
// (0048), so it also writes the alert's kind and time to
// `ops.security_alert_log` (0067) in the transaction that raises it, and the
// view reads that log. An installation-level alert names no business, and the
// detector counts every business's signals, so the log is the installation's:
// only the business that operates it (`ops.installation.operator_business_id`,
// alpha here, as provisioning sets it) sees it. Another business's operator
// reads an empty list, since an alert's time could tell them when alpha's
// people failed a sign-in or exported; with no operating business set, nobody
// sees them.
//
// Noah holds `operations:read` alone in alpha; Mia holds neither key; Bea
// holds both in bravo. A client of alpha holds a share and nothing else, and
// the agent acts under a live delegation from Ada, who holds both keys.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOutboxAlerts } from '../../apps/api/alerts/outbox.ts';
import { RULES } from '../../apps/api/alerts/detect.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { connectOutbox } from '../../packages/core-records/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { agentPath, bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import { attempt, Client } from '../db/backup-identity.fixture.ts';
import { c55Keys, pathOf } from './c55-operations-world.ts';
import {
  forwarderOn,
  grantsOnAlertLog,
  ROOT,
  sink,
  type AlertView,
  type TestSink,
} from './c55-security-alerts-world.ts';

const CANARY = `CANARY-c55-alert-${randomBytes(6).toString('hex')}`;
const UNKNOWN = 'An alert of an unknown kind';
const SECRET_SCAN =
  'The secret scan failed: a password or key may have been written where it should not be.';

if (serverUrl === undefined) {
  console.warn('operations/c55-security-alerts: DATABASE_URL is unset, so nothing below ran.');
}

let harness: Harness;
let credential: string;
let clientToken: string;

const view = async (token = harness.world.ada.token, businessKey = 'alpha') =>
  await call(
    harness.world.api,
    personPath(businessKey, pathOf('operations.read')),
    { operationId: `c55-${randomUUID()}` },
    bearer(token),
  );

const alertsOf = async (token?: string, businessKey?: string): Promise<readonly AlertView[]> => {
  const answer = await view(token, businessKey);
  expect(answer.status).toBe(200);
  expect(answer.body['securityAlerts'], 'the view lists security alerts').toBeInstanceOf(Array);
  return answer.body['securityAlerts'] as readonly AlertView[];
};

const admin = async <T>(sql: string, parameters: unknown[] = []): Promise<readonly T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, parameters)) as T[];

const forwarder = (to: TestSink) => forwarderOn(harness.world.db.admin, to);

/** One signal the detector raises an alert on at once (threshold 1). */
const secretScanFailed = async () =>
  await admin(`insert into ops.api_events (kind) values ('secret-scan-failed')`);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('c55_alerts');
  ({ credential, clientToken } = await c55Keys(harness));
}, 120_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  await harness?.close();
});

describe.skipIf(serverUrl === undefined)('C55 security alerts', () => {
  it('C55 security alerts listed: an alert the forwarder raises shows with its kind, time and words, and stays once the sink took it', async () => {
    const before = await alertsOf();
    await secretScanFailed();
    // The sink is down: the alert is raised and kept, and the view lists it already.
    await expect(forwarder(sink('the sink is down')).once()).rejects.toThrow();
    const [kept] = await admin<{ id: string; at: Date }>('select id, at from ops.api_alerts');
    expect(kept).toBeDefined();
    const whileKept = await alertsOf();
    expect(whileKept.length).toBe(before.length + 1);

    // The sink takes it and the forwarder deletes its row; the view keeps it, once.
    const to = sink();
    await forwarder(to).once();
    expect(to.events.map((event) => event.tags['alert'])).toEqual(['secret-scan-failed']);
    expect(await admin('select 1 from ops.api_alerts')).toEqual([]);
    const after = await alertsOf();
    expect(after).toEqual(whileKept);
    const [shown] = after;
    expect(Object.keys(shown ?? {}).toSorted()).toEqual(['at', 'concerns', 'kind']);
    expect(shown).toEqual({
      kind: 'secret-scan-failed',
      at: kept?.at.toISOString(),
      concerns: SECRET_SCAN,
    });
    // Never the alert's id at the sink, which the view has no column for.
    expect(JSON.stringify(after)).not.toContain(kept?.id ?? 'no id');
    expect(JSON.stringify(after)).not.toContain(to.events[0]?.event_id ?? 'no id');

    // Newest first: the next alert raised leads.
    await admin(`insert into ops.api_events (kind, scope) values ('authority-changed', $1)`, [
      'cd'.repeat(32),
    ]);
    await forwarder(sink()).once();
    expect((await alertsOf()).map((alert) => alert.kind).slice(0, 2)).toEqual([
      'authority-changed',
      'secret-scan-failed',
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('C55 security alerts', () => {
  it('C55 security alerts listed: every kind the forwarder raises has its own words; any other kind reads as unknown', async () => {
    const raised = [
      ...new Set([...Object.values(RULES).map((rule) => rule.alert), 'signals-dropped']),
    ];
    const odd = ['constructor', 'to-string', 'zz-not-a-kind'];
    await admin(
      `insert into ops.security_alert_log (kind, at)
         select kind, now() + interval '1 hour' from unnest($1::text[]) as k(kind)`,
      [[...raised, ...odd]],
    );
    const shown = (await alertsOf()).slice(0, raised.length + odd.length);
    const words = new Map(shown.map((alert) => [alert.kind, alert.concerns]));
    for (const kind of raised) {
      expect(words.get(kind), kind).toMatch(/^[A-Z].*\.$/u);
      expect(words.get(kind), kind).not.toBe(UNKNOWN);
      expect(words.get(kind), kind).not.toContain(kind);
    }
    for (const kind of odd) expect(words.get(kind), kind).toBe(UNKNOWN);
    expect(new Set(raised.map((kind) => words.get(kind))).size).toBe(raised.length);
    await admin(`delete from ops.security_alert_log where at > now() + interval '30 minutes'`);
  });

  it('C55 security alerts listed: the read is bounded to the newest 50', async () => {
    await admin(
      `insert into ops.security_alert_log (kind, at)
         select 'export-volume', now() - make_interval(days => 400 + n) from generate_series(1, 60) n`,
    );
    const shown = await alertsOf();
    expect(shown.length).toBe(50);
    const times = shown.map((alert) => Date.parse(alert.at));
    expect(times).toEqual(times.toSorted((a, b) => b - a));
    expect(times[0]).toBeGreaterThan(Date.now() - 86_400_000);
  });
});

describe.skipIf(serverUrl === undefined)('C55 security alerts', () => {
  it('C55 isolation: security alerts reach only the operating business: a member without the key, a client, a delegated agent and another business never see them', async () => {
    await secretScanFailed();
    await forwarder(sink()).once();
    expect((await alertsOf(harness.world.noah.token)).length).toBeGreaterThan(0);

    for (const token of [harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await view(token);
      expect(refused.status).toBe(403);
      expect(refused.code).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused.body)).not.toContain('secret-scan-failed');
    }
    const agent = await call(
      harness.world.api,
      agentPath('alpha', pathOf('operations.read')),
      { operationId: randomUUID() },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(agent.status).toBe(403);
    expect(agent.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(JSON.stringify(agent.body)).not.toContain('secret-scan-failed');

    // Bea holds operations:read in bravo, which does not operate the
    // installation: the alerts are alpha's to see, so bravo's list is empty.
    expect(await alertsOf(harness.world.bea.token, 'bravo')).toEqual([]);
    const across = await view(harness.world.bea.token, 'alpha');
    expect(across.status).toBe(403);
    expect(across.code).toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(across.body)).not.toContain('secret-scan-failed');
  });

  it('C55 isolation: with no operating business set, no business sees a security alert', async () => {
    await admin('update ops.installation set operator_business_id = null');
    try {
      expect(await alertsOf()).toEqual([]);
      expect(await alertsOf(harness.world.bea.token, 'bravo')).toEqual([]);
    } finally {
      await admin('update ops.installation set operator_business_id = $1', [harness.world.alpha]);
    }
    expect((await alertsOf()).length).toBeGreaterThan(0);
  });
});

describe.skipIf(serverUrl === undefined)('C55 security alerts', () => {
  it("C55 canary: a planted secret in an alert's surroundings never reaches the view, the log table, logs or refusals", async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const answers: unknown[] = [];
    try {
      const outbox = connectOutbox(harness.world.db.appUrl, { source: 'runtime' });
      const alerts = createOutboxAlerts({
        outbox,
        key: randomBytes(32),
        where: 'staging',
        root: ROOT,
      });
      await alerts.fault(new TypeError(CANARY));
      alerts.observe({ kind: 'secret-scan-failed' });
      await alerts.settled();
      await outbox.close();
      // The sink refuses with the canary in its words, then takes everything.
      await expect(forwarder(sink(CANARY)).once()).rejects.toThrow();
      await forwarder(sink()).once();
      answers.push(
        (await view()).body,
        (await view(harness.world.noah.token)).body,
        (await view(harness.world.bea.token, 'bravo')).body,
        (await view(harness.world.mia.token)).body,
        (await view(clientToken)).body,
        (await view(harness.world.bea.token, 'alpha')).body,
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(JSON.stringify(answers)).toContain('secret-scan-failed');
    expect(JSON.stringify(answers)).not.toContain(CANARY);
    expect(logged.join('\n')).not.toContain(CANARY);
    const stored = await admin<{ row: string }>(
      'select to_jsonb(l)::text as row from ops.security_alert_log l',
    );
    expect(stored.map((row) => row.row).join('\n')).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)('C55 security alerts', () => {
  it('C55 security alerts grant: the application group selects kind and time alone, changes nothing, and cannot read ops.api_alerts', async () => {
    const app = new Client(harness.world.db.appUrl);
    try {
      expect(await attempt(app, 'select kind, at from ops.security_alert_log')).toBe('ok');
      for (const text of [
        'select seq from ops.security_alert_log',
        'select * from ops.security_alert_log',
        `insert into ops.security_alert_log (kind) values ('test')`,
        'update ops.security_alert_log set kind = kind',
        'delete from ops.security_alert_log',
        'truncate ops.security_alert_log',
        'select id, kind, at from ops.api_alerts',
        'select count(*) from ops.api_alerts',
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(app, text), text).toBe('42501');
      }
    } finally {
      await app.end();
    }
    // Every grant on the table, by grantee: nothing to PUBLIC (grantee 0), the
    // application its two columns' select, the forwarder the kind's insert,
    // and the backup identity what 0045's default privileges give every table.
    const held = await grantsOnAlertLog(harness.world.db.admin);
    expect(held).toEqual([
      'ops_astro_app SELECT at',
      'ops_astro_app SELECT kind',
      'ops_astro_backup SELECT *',
      'ops_astro_forwarder INSERT kind',
    ]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// C55: the operations view (`operations.read`, behind `operations:read`) and
// the privacy incident record (`privacy.record_incident`, the tracked action
// `privacy incident recorded`, behind `privacy:manage`), through the real API.
//
// Ada is alpha's owner and holds both keys; Noah holds `operations:read` alone;
// Mia holds neither; Bea is bravo's owner and holds both there. A client of
// alpha holds a share and nothing else, and the agent acts under a live
// delegation from Ada, who holds both keys.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

const CANARY = 'CANARY-c55-incident-detail-4b91d2';

if (serverUrl === undefined) {
  console.warn('operations/c55-operations-view: DATABASE_URL is unset, so nothing below ran.');
}

/** A valid incident, found an hour ago; `overrides` replaces any field. */
const incident = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId: `c55-${randomUUID()}`,
  whatHappened: 'A client folder link reached the wrong person.',
  foundAt: new Date(Date.now() - 3_600_000).toISOString(),
  foundBy: 'The second operator',
  affected: 'One client; two of their customers.',
  informationKinds: ['contact'],
  ...overrides,
});

interface IncidentView {
  readonly id: string;
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly string[];
  readonly assessBy: string;
  readonly status: string;
}

/** The route of an operation, as `pathOf` in the surface builds it. */
const pathOf = (name: 'operations.read' | 'privacy.record_incident') =>
  `/${name.replace('.', '/')}`;

/** A world caller as the fixture's member, which carries the same ids. */
const member = (caller: unknown) => caller as Member;

const incidentsOf = (answer: Answer): readonly IncidentView[] =>
  (answer.body['privacyIncidents'] ?? []) as readonly IncidentView[];

describe.skipIf(serverUrl === undefined)('C55 the operations view', () => {
  let harness: Harness;
  let credential: string;
  let clientToken: string;

  const asCaller = async (
    token: string,
    name: 'operations.read' | 'privacy.record_incident',
    body: Readonly<Record<string, unknown>>,
    businessKey = 'alpha',
  ) => await call(harness.world.api, personPath(businessKey, pathOf(name)), body, bearer(token));

  const record = async (
    body: Readonly<Record<string, unknown>> = incident(),
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => await asCaller(token, 'privacy.record_incident', body, businessKey);

  const view = async (token = harness.world.ada.token, businessKey = 'alpha') =>
    await asCaller(token, 'operations.read', { operationId: `c55-${randomUUID()}` }, businessKey);

  const incidentRows = async (businessId: string) =>
    await harness.world.db.app.withBusiness(businessId, async (tx) =>
      tx.query<{ readonly n: number }>('select count(*)::int as n from public.privacy_incidents'),
    );

  beforeAll(async () => {
    harness = await createHarness('c55_operations');
    const { world } = harness;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, member(world.ada), 'read', WHOLE_BUSINESS, true, 'operations');
      await grantTo(tx, member(world.ada), 'manage', WHOLE_BUSINESS, true, 'privacy');
      await grantTo(tx, member(world.noah), 'read', WHOLE_BUSINESS, false, 'operations');
    });
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, member(world.bea), 'read', WHOLE_BUSINESS, false, 'operations');
      await grantTo(tx, member(world.bea), 'manage', WHOLE_BUSINESS, false, 'privacy');
    });
    const client = await shareWithClient(
      world.db.app,
      world.alpha,
      member(world.ada),
      harness.alphaTask.id,
    );
    clientToken = await tokenFor(client.presented.subject);

    const { decided } = await harness.approvedReservation();
    expect(decided.code, 'the decision a pickup needs').toBe('ok');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    expect(picked.code, 'the pickup').toBe('ok');
    credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('C55 records: the owner records a privacy incident, and the view shows it with its 30-day assessment date', async () => {
    const body = incident({ informationKinds: ['contact', 'financial'] });
    const recorded = await record(body);
    expect(recorded.status).toBe(200);
    expect(recorded.code).toBe('ok');

    const shown = await view();
    expect(shown.status).toBe(200);
    const found = incidentsOf(shown).find((row) => row.whatHappened === body.whatHappened);
    expect(found).toMatchObject({
      foundBy: body.foundBy,
      affected: body.affected,
      informationKinds: ['contact', 'financial'],
      status: 'open',
    });
    const day0 = Date.parse(body.foundAt);
    expect(Date.parse(found?.foundAt ?? '')).toBe(day0);
    expect(Date.parse(found?.assessBy ?? '')).toBe(day0 + 30 * 86_400_000);

    // Audited as the tracked action, with a digest and never the words.
    const events = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
      tx.query<{ readonly outcome: string; readonly row: string }>(
        `select outcome, to_jsonb(e)::text as row from public.audit_events e
          where command = 'privacy.record_incident' order by seq`,
      ),
    );
    expect(events.at(-1)?.outcome).toBe('applied');
    expect(events.map((event) => event.row).join('\n')).not.toContain(body.whatHappened);
  });

  it('C55 records: a malformed incident is refused and nothing is recorded', async () => {
    const before = await incidentRows(harness.world.alpha);
    const cases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      incident({ whatHappened: '' }),
      incident({ whatHappened: 'x'.repeat(4001) }),
      incident({ foundBy: '   ' }),
      incident({ affected: 7 }),
      incident({ foundAt: 'yesterday' }),
      incident({ foundAt: new Date(Date.now() + 3_600_000).toISOString() }),
      incident({ informationKinds: [] }),
      incident({ informationKinds: ['contact', 'contact'] }),
      incident({ informationKinds: ['gossip'] }),
      incident({ status: 'closed' }),
    ];
    for (const body of cases) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await record(body);
      expect(answer.status, JSON.stringify(body).slice(0, 120)).toBe(422);
    }
    expect(await incidentRows(harness.world.alpha)).toEqual(before);
  });

  it('C55 refusal privacy:manage: a holder of operations:read alone, a member and a client are refused, and nothing is recorded', async () => {
    const before = await incidentRows(harness.world.alpha);
    for (const token of [harness.world.noah.token, harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await record(incident(), token);
      expect(answer.status).toBe(403);
      expect(answer.code).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await incidentRows(harness.world.alpha)).toEqual(before);
  });

  it('C55 refusal operations:read: a member without the key and a client are refused the view; a holder of it alone reads it', async () => {
    for (const token of [harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await view(token);
      expect(answer.status).toBe(403);
      expect(answer.code).toBe('SCOPE_NOT_GRANTED');
      expect(answer.body['privacyIncidents']).toBeUndefined();
    }
    const noah = await view(harness.world.noah.token);
    expect(noah.status).toBe(200);
    expect(incidentsOf(noah).length).toBeGreaterThan(0);
  });

  it('C55 isolation: another business, another client and a delegated agent never read, count or record an incident', async () => {
    const planted = incident({ whatHappened: `alpha only ${randomUUID()}` });
    expect((await record(planted)).status).toBe(200);
    const alphaCount = await incidentRows(harness.world.alpha);

    // Another business: Bea records and reads in bravo and sees only bravo's.
    const bravoOwn = incident({ whatHappened: `bravo only ${randomUUID()}` });
    expect((await record(bravoOwn, harness.world.bea.token, 'bravo')).status).toBe(200);
    const bravoView = await view(harness.world.bea.token, 'bravo');
    expect(bravoView.status).toBe(200);
    expect(incidentsOf(bravoView).map((row) => row.whatHappened)).toEqual([bravoOwn.whatHappened]);
    // Bea on alpha's prefix is no member of alpha.
    const across = await view(harness.world.bea.token, 'alpha');
    expect(across.status).toBe(403);
    expect(across.code).toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(across.body)).not.toContain(planted.whatHappened);

    // Another client in the same business: a share on alpha's task reaches
    // neither the view nor the record.
    const client = await view(clientToken);
    expect(client.status).toBe(403);
    expect(JSON.stringify(client.body)).not.toContain(planted.whatHappened);

    // Another person under a live delegation: the agent acting for Ada, who
    // holds both keys, is refused both, on the agent prefix.
    for (const name of ['operations.read', 'privacy.record_incident'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const agent = await call(
        harness.world.api,
        agentPath('alpha', pathOf(name)),
        name === 'operations.read' ? { operationId: randomUUID() } : incident(),
        { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
      );
      expect(agent.status, name).toBe(403);
      expect(agent.code, name).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(JSON.stringify(agent.body)).not.toContain(planted.whatHappened);
    }

    expect(await incidentRows(harness.world.alpha)).toEqual(alphaCount);
    const alphaView = await view();
    expect(incidentsOf(alphaView).map((row) => row.whatHappened)).not.toContain(
      bravoOwn.whatHappened,
    );
  });

  it('C55 canary: incident words reach no log, audit row or refusal', async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    try {
      expect((await record(incident({ whatHappened: CANARY, affected: CANARY }))).status).toBe(200);
      const refusals = [
        await record(incident({ whatHappened: CANARY }), harness.world.mia.token),
        await record(incident({ whatHappened: CANARY, foundAt: 'never' })),
        await record(incident({ whatHappened: CANARY }), harness.world.bea.token, 'alpha'),
        await view(harness.world.mia.token),
      ];
      for (const refusal of refusals) {
        expect(refusal.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(refusal.body)).not.toContain(CANARY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(CANARY);

    const stored = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
      tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'privacy.record_incident'`,
      ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((row) => row.row).join('\n')).not.toContain(CANARY);
  });
});

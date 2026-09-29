// SPDX-License-Identifier: AGPL-3.0-only
//
// C81's breach drill (TR-SEC-11), through the real API: the 30-day assessment
// clock on the operations view (`operations.read`), the link from the incident
// record to the breach runbook published most recently, and the notices the
// runbook's template drafts for the OAIC and each affected person
// (`privacy.draft_breach_notices`, a read under `privacy:manage`). Nothing is
// ever sent: the read answers drafts, and the owner decides (owner line 54).
//
// Ada is alpha's owner and holds both keys; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds both there. A
// client of alpha holds a share and nothing else, and the agent acts under a
// live delegation from Ada. The runbook's words are made up: the owner's text
// is installation data, and this repository never names the agency.

import { createHash, randomUUID } from 'node:crypto';
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

const CANARY = 'CANARY-c81-drill-recipient-5d17a9';
const DAY_MS = 24 * 60 * 60 * 1000;

if (serverUrl === undefined) {
  console.warn('operations/c81-breach-drill: DATABASE_URL is unset, so nothing below ran.');
}

type Name =
  | 'operations.read'
  | 'privacy.record_incident'
  | 'privacy.draft_breach_notices'
  | 'legal.draft_version'
  | 'legal.approve_version'
  | 'legal.publish_version';

/** The route of an operation, as `pathOf` in the surface builds it. */
const pathOf = (name: Name) => `/${name.replace('.', '/')}`;

const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
const member = (caller: unknown) => caller as Member;

const detailOf = (answer: Answer) => (answer.body['detail'] ?? {}) as Record<string, unknown>;

/** A made-up runbook in the owner's shape: who acts, the clock, and the one template. */
const runbookWords = (marker: string) =>
  [
    '# Data breach runbook (one page)',
    '',
    `Made-up text ${marker}.`,
    '',
    '**Who.** The owner decides at every step. The second operator assists.',
    '',
    '4. **Assess promptly, and finish within 30 calendar days of day 0.**',
    '',
    '## Template: notice to affected people',
    '',
    '> Subject: A privacy incident involving your information',
    '> Dear `<name>`,',
    '>',
    '> **What happened:** on `<date>` we found that `<plain description: what, how, when it started, when it stopped>`.',
    '> **Information involved:** `<kinds>`.',
    '> **What we have done:** `<containment and changes>`.',
    '> **What we recommend you do:** `<steps>`.',
    '>',
    '> For questions, write to the address on our website.',
    '',
    '## Sources',
    '',
    '- Made up for the drill.',
    '',
  ].join('\n');

/** A valid incident found `daysAgo` days before now; `overrides` replaces any field. */
const incident = (daysAgo: number, overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId: `c81d-${randomUUID()}`,
  whatHappened: `A client folder link reached the wrong person (${randomUUID()}).`,
  foundAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  foundBy: 'The second operator',
  affected: 'One client; two of their customers.',
  informationKinds: ['contact', 'financial'],
  ...overrides,
});

interface IncidentView {
  readonly id: string;
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly assessBy: string;
  readonly recordedAt: string;
  readonly status: string;
  readonly overdue: boolean;
}

interface Notice {
  readonly to: string;
  readonly name: string;
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

/** The drill's recipients and the words only the owner can give; `overrides` replaces any. */
const recipients = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  oaic: {
    name: 'Office of the Australian Information Commissioner',
    address: 'drill-oaic@example.test',
  },
  people: [
    { name: 'Pat Example', address: 'pat@example.test' },
    { name: 'Sam Example', address: 'PO Box 1, Example QLD 4000' },
  ],
  containment: 'We replaced the link and checked the folder.',
  steps: 'Watch for messages that ask you to confirm your details.',
  ...overrides,
});

const incidentsOf = (answer: Answer): readonly IncidentView[] =>
  (answer.body['privacyIncidents'] ?? []) as readonly IncidentView[];

const noticesOf = (answer: Answer): readonly Notice[] =>
  (answer.body['notices'] ?? []) as readonly Notice[];

describe.skipIf(serverUrl === undefined)('C81 the breach drill', () => {
  let harness: Harness;
  let credential: string;
  let clientToken: string;

  const as = async (
    token: string,
    name: Name,
    body: Readonly<Record<string, unknown>>,
    businessKey = 'alpha',
  ) => await call(harness.world.api, personPath(businessKey, pathOf(name)), body, bearer(token));

  const record = async (
    body: Readonly<Record<string, unknown>>,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => {
    const answer = await as(token, 'privacy.record_incident', body, businessKey);
    expect(answer.status, 'the incident is recorded').toBe(200);
    return String(detailOf(answer)['incidentId']);
  };

  const view = async (token = harness.world.ada.token, businessKey = 'alpha') =>
    await as(token, 'operations.read', { operationId: `c81d-${randomUUID()}` }, businessKey);

  /** Draft, approve and publish a breach runbook; answers its words. */
  const publishRunbook = async (
    version: string,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => {
    const body = runbookWords(randomUUID());
    const drafted = await as(
      token,
      'legal.draft_version',
      { operationId: `c81d-${randomUUID()}`, document: 'breach-runbook', version, body },
      businessKey,
    );
    expect(drafted.status, 'drafted').toBe(200);
    const versionId = detailOf(drafted)['versionId'];
    const approved = await as(
      token,
      'legal.approve_version',
      { operationId: `c81d-${randomUUID()}`, versionId, digest: digestOf(body) },
      businessKey,
    );
    expect(approved.status, 'approved').toBe(200);
    const published = await as(
      token,
      'legal.publish_version',
      { operationId: `c81d-${randomUUID()}`, versionId },
      businessKey,
    );
    expect(published.status, 'published').toBe(200);
    return body;
  };

  const drill = async (
    incidentId: unknown,
    overrides: Readonly<Record<string, unknown>> = {},
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) =>
    await as(
      token,
      'privacy.draft_breach_notices',
      { operationId: `c81d-${randomUUID()}`, incidentId, ...recipients(overrides) },
      businessKey,
    );

  const drillAudits = (businessId: string) =>
    harness.world.db.app.withBusiness(businessId, (tx) =>
      tx.query<{ readonly n: number }>(
        `select count(*)::int as n from public.audit_events
          where command = 'privacy.draft_breach_notices'`,
      ),
    );

  const writes = (businessId: string) =>
    harness.world.db.app.withBusiness(businessId, (tx) =>
      tx.query<{
        readonly incidents: number;
        readonly versions: number;
        readonly operations: number;
      }>(
        `select (select count(*)::int from public.privacy_incidents) as incidents,
                (select count(*)::int from public.legal_document_versions) as versions,
                (select count(*)::int from public.operations) as operations`,
      ),
    );

  beforeAll(async () => {
    harness = await createHarness('c81_drill');
    const { world } = harness;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
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

  it('C81 breach drill 30-day assessment: the clock starts at awareness, and an assessment left past day 30 is flagged', async () => {
    const late = await record(incident(31));
    const early = await record(incident(29));
    const now = await record(incident(0.01));

    const answer = await view();
    expect(answer.status).toBe(200);
    const byId = new Map(incidentsOf(answer).map((row) => [row.id, row]));
    for (const id of [late, early, now]) {
      const row = byId.get(id);
      expect(row, id).toBeDefined();
      // Day 0 is when it was found, not when it was recorded: 30 days from foundAt.
      expect(Date.parse(row?.assessBy ?? ''), id).toBe(
        Date.parse(row?.foundAt ?? '') + 30 * DAY_MS,
      );
      expect(Date.parse(row?.recordedAt ?? ''), id).toBeGreaterThan(Date.parse(row?.foundAt ?? ''));
    }
    expect(byId.get(late)?.overdue, 'found 31 days ago, still open').toBe(true);
    expect(byId.get(early)?.overdue, 'found 29 days ago').toBe(false);
    expect(byId.get(now)?.overdue, 'found today').toBe(false);

    // A holder of operations:read alone sees the same flag.
    const noah = await view(harness.world.noah.token);
    expect(noah.status).toBe(200);
    expect(incidentsOf(noah).find((row) => row.id === late)?.overdue).toBe(true);
  });

  it('C81 breach drill notices: the OAIC and each affected person receive the notice at the named recipient, and a drill with a recipient missing fails', async () => {
    const incidentBody = incident(3);
    const incidentId = await record(incidentBody);

    // No runbook published yet: nothing to draft from.
    const before = await drill(incidentId);
    expect({ status: before.status, code: before.code }).toEqual({
      status: 409,
      code: 'BREACH_RUNBOOK_UNPUBLISHED',
    });
    const beforeView = await view();
    expect(beforeView.body['breachRunbook'], 'the view links no runbook yet').toBeNull();

    await publishRunbook('1.0');
    const newest = await publishRunbook('1.1');

    // The incident record links the runbook published most recently.
    const linked = await view();
    const runbook = linked.body['breachRunbook'] as Record<string, unknown>;
    expect(runbook['version']).toBe('1.1');
    expect(runbook['digest']).toBe(digestOf(newest));
    expect(runbook['body']).toBe(newest);

    const writesBefore = await writes(harness.world.alpha);
    const auditsBefore = await drillAudits(harness.world.alpha);
    const drafted = await drill(incidentId);
    expect(drafted.status).toBe(200);
    expect(drafted.body['runbook']).toEqual({ version: '1.1', digest: digestOf(newest) });

    const notices = noticesOf(drafted);
    expect(notices.map((notice) => [notice.to, notice.name, notice.address])).toEqual([
      ['oaic', 'Office of the Australian Information Commissioner', 'drill-oaic@example.test'],
      ['person', 'Pat Example', 'pat@example.test'],
      ['person', 'Sam Example', 'PO Box 1, Example QLD 4000'],
    ]);
    const given = recipients();
    for (const notice of notices) {
      expect(notice.subject).toBe('A privacy incident involving your information');
      expect(notice.body).toContain(`Dear ${notice.name},`);
      expect(notice.body).toContain(`on ${incidentBody.foundAt.slice(0, 10)} we found that`);
      expect(notice.body).toContain(incidentBody.whatHappened);
      expect(notice.body).toContain('**Information involved:** contact, financial.');
      expect(notice.body).toContain(given.containment);
      expect(notice.body).toContain(given.steps);
      expect(notice.body, 'every placeholder is filled').not.toMatch(/`<[^`]*>`/u);
      expect(notice.body).not.toContain('Subject:');
      expect(notice.body).not.toMatch(/^>/mu);
    }

    // Nothing sent and nothing written: the read's one audit event only.
    expect(await writes(harness.world.alpha)).toEqual(writesBefore);
    expect((await drillAudits(harness.world.alpha))[0]?.n).toBe((auditsBefore[0]?.n ?? 0) + 1);

    // A recipient missing, or one without an address, fails by name.
    const missing: readonly [string, Readonly<Record<string, unknown>>][] = [
      ['oaic', { oaic: undefined }],
      ['oaic', { oaic: { name: 'OAIC', address: '' } }],
      ['oaic', { oaic: { name: '', address: 'drill-oaic@example.test' } }],
      ['people', { people: [] }],
      ['people', { people: undefined }],
      ['people', { people: [{ name: 'Pat Example' }] }],
      ['people', { people: [{ name: 'Pat Example', address: '   ' }] }],
      ['people', { people: [{ address: 'pat@example.test' }] }],
      ['people', { people: ['pat@example.test'] }],
      ['containment', { containment: '' }],
      ['steps', { steps: undefined }],
    ];
    for (const [field, overrides] of missing) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await drill(incidentId, overrides);
      expect({ status: refused.status, code: refused.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(refused.body), field).toContain(field);
      expect(noticesOf(refused), field).toEqual([]);
    }
    const unknown = await drill(randomUUID());
    expect({ status: unknown.status, code: unknown.code }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    const badId = await drill('not-an-id');
    expect({ status: badId.status, code: badId.code }).toEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });

    // A runbook whose template the drill cannot fill drafts nothing.
    const unfillable = runbookWords(randomUUID()).replace('`<steps>`', '`<the weather>`');
    const drafted2 = await as(harness.world.ada.token, 'legal.draft_version', {
      operationId: `c81d-${randomUUID()}`,
      document: 'breach-runbook',
      version: '1.2',
      body: unfillable,
    });
    const versionId = detailOf(drafted2)['versionId'];
    expect(
      (
        await as(harness.world.ada.token, 'legal.approve_version', {
          operationId: `c81d-${randomUUID()}`,
          versionId,
          digest: digestOf(unfillable),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(harness.world.ada.token, 'legal.publish_version', {
          operationId: `c81d-${randomUUID()}`,
          versionId,
        })
      ).status,
    ).toBe(200);
    const unfilled = await drill(incidentId);
    expect({ status: unfilled.status, code: unfilled.code }).toEqual({
      status: 409,
      code: 'BREACH_TEMPLATE_UNFILLED',
    });
    expect(noticesOf(unfilled)).toEqual([]);

    // A fillable version published after it drafts again.
    await publishRunbook('1.3');
    expect((await drill(incidentId)).status).toBe(200);
  });

  it('C81 refusal privacy:manage: the notices are refused to a holder of operations:read alone, a member and a client', async () => {
    const incidentId = await record(incident(1));
    for (const [who, token] of [
      ['noah', harness.world.noah.token],
      ['mia', harness.world.mia.token],
      ['client', clientToken],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await drill(incidentId, {}, token);
      expect(refused.status, who).toBe(403);
      expect(noticesOf(refused), who).toEqual([]);
    }
  });

  it('C81 isolation: another business, another client and a delegated agent never draft from or learn of an incident or runbook', async () => {
    const alphaIncident = await record(incident(2));
    const bravoIncident = await record(incident(2), harness.world.bea.token, 'bravo');

    // Another business: bravo has no published runbook of its own, and alpha's
    // is never drawn on for bravo; nor is alpha's incident reached from bravo.
    const bravoOwn = await drill(bravoIncident, {}, harness.world.bea.token, 'bravo');
    expect({ status: bravoOwn.status, code: bravoOwn.code }).toEqual({
      status: 409,
      code: 'BREACH_RUNBOOK_UNPUBLISHED',
    });
    const bravoView = await view(harness.world.bea.token, 'bravo');
    expect(bravoView.status).toBe(200);
    expect(bravoView.body['breachRunbook']).toBeNull();
    const crossing = await drill(alphaIncident, {}, harness.world.bea.token, 'bravo');
    expect({ status: crossing.status, code: crossing.code }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    const fromAlpha = await drill(bravoIncident);
    expect({ status: fromAlpha.status, code: fromAlpha.code }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    const bea = await drill(alphaIncident, {}, harness.world.bea.token, 'alpha');
    expect({ status: bea.status, code: bea.code }).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });

    // Another client in the same business: a share reaches no notice.
    const client = await drill(alphaIncident, {}, clientToken);
    expect(client.status).toBe(403);
    expect(JSON.stringify(client.body)).not.toContain(alphaIncident);

    // Another person under a live delegation: the agent acting for Ada.
    const agent = await call(
      harness.world.api,
      agentPath('alpha', pathOf('privacy.draft_breach_notices')),
      { operationId: randomUUID(), incidentId: alphaIncident, ...recipients() },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(agent.status).toBe(403);
    expect(agent.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(noticesOf(agent)).toEqual([]);

    for (const refused of [crossing, fromAlpha, bea, client, agent]) {
      expect(JSON.stringify(refused.body)).not.toContain('Dear ');
    }
  });

  it('C81 isolation canary: a recipient reaches no log, audit row, operation register row or refusal', async () => {
    const incidentId = await record(incident(4));
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const planted = { people: [{ name: CANARY, address: `${CANARY}@example.test` }] };
    try {
      const drafted = await drill(incidentId, planted);
      expect(drafted.status).toBe(200);
      const refusals = [
        await drill(incidentId, planted, harness.world.mia.token),
        await drill(incidentId, { ...planted, steps: '' }),
        await drill(incidentId, planted, harness.world.bea.token, 'alpha'),
        await drill(randomUUID(), planted),
      ];
      for (const refusal of refusals) {
        expect(refusal.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(refusal.body)).not.toContain(CANARY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(CANARY);

    const stored = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'privacy.draft_breach_notices'
         union all
         select to_jsonb(o)::text from public.operations o
          where command = 'privacy.draft_breach_notices'`,
      ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((row) => row.row).join('\n')).not.toContain(CANARY);
  });
});

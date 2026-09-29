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
//
// The world is `c81-breach-drill-world.ts`; the 30-day assessment clock is in
// `c81-breach-drill-clock.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  as,
  CANARY,
  clientToken,
  closeDrill,
  credential,
  detailOf,
  digestOf,
  drill,
  drillAudits,
  harness,
  incident,
  noticesOf,
  openDrill,
  pathOf,
  publishRunbook,
  recipients,
  record,
  runbookWords,
  view,
  writes,
} from './c81-breach-drill-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-breach-drill: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openDrill('c81_drill');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeDrill();
});

describe.skipIf(serverUrl === undefined)('C81 the breach drill', () => {
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

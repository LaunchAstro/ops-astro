// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C81 breach-drill cases share (`c81-breach-drill.test.ts` and
// `c81-breach-drill-canary.test.ts`): each file opens its own.
//
// Ada is alpha's owner and holds `privacy:manage`; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds both keys there. A
// client of alpha holds a share and nothing else, and the agent acts under a
// live delegation from Ada.

import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, type Answer } from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const CANARY = 'CANARY-c81-drill-recipient-5d17a9';
export const DAY_MS: number = 24 * 60 * 60 * 1000;

export type Name =
  | 'operations.read'
  | 'privacy.record_incident'
  | 'privacy.draft_breach_notices'
  | 'legal.draft_version'
  | 'legal.approve_version'
  | 'legal.publish_version';

/** The route of an operation, as `pathOf` in the surface builds it. */
export const pathOf = (name: Name): string => `/${name.replace('.', '/')}`;

export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
export const member = (caller: unknown): Member => caller as Member;

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

/** A made-up runbook in the owner's shape: who acts, the clock, and the one template. */
export const runbookWords = (marker: string): string =>
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
/** An incident as the cases send it: the fields below, and any override. */
export interface SentIncident {
  readonly [field: string]: unknown;
  readonly operationId: string;
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly string[];
}

export const incident = (
  daysAgo: number,
  overrides: Readonly<Record<string, unknown>> = {},
): SentIncident => ({
  operationId: `c81d-${randomUUID()}`,
  whatHappened: `A client folder link reached the wrong person (${randomUUID()}).`,
  foundAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  foundBy: 'The second operator',
  affected: 'One client; two of their customers.',
  informationKinds: ['contact', 'financial'],
  ...overrides,
});

export interface IncidentView {
  readonly id: string;
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly assessBy: string;
  readonly recordedAt: string;
  readonly status: string;
  readonly overdue: boolean;
}

export interface Notice {
  readonly to: string;
  readonly name: string;
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

/** The drill's recipients and the words only the owner can give; `overrides` replaces any. */
/** A named recipient: who, and where the notice goes. */
export interface Recipient {
  readonly name: string;
  readonly address: string;
}

/** The recipients and the owner's words a drill sends, and any override. */
export interface SentRecipients {
  readonly [field: string]: unknown;
  readonly oaic: Recipient;
  readonly people: readonly Recipient[];
  readonly containment: string;
  readonly steps: string;
}

export const recipients = (overrides: Readonly<Record<string, unknown>> = {}): SentRecipients => ({
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

export const incidentsOf = (answer: Answer): readonly IncidentView[] =>
  (answer.body['privacyIncidents'] ?? []) as readonly IncidentView[];

export const noticesOf = (answer: Answer): readonly Notice[] =>
  (answer.body['notices'] ?? []) as readonly Notice[];

export let harness: Harness;
export let credential: string;
export let clientToken: string;

export const as = async (
  token: string,
  name: Name,
  body: Readonly<Record<string, unknown>>,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await call(harness.world.api, personPath(businessKey, pathOf(name)), body, bearer(token));

export const record = async (
  body: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<string> => {
  const answer = await as(token, 'privacy.record_incident', body, businessKey);
  expect(answer.status, 'the incident is recorded').toBe(200);
  return String(detailOf(answer)['incidentId']);
};

export const view = async (
  token: string = harness.world.ada.token,
  businessKey = 'alpha',
): Promise<Answer> =>
  await as(token, 'operations.read', { operationId: `c81d-${randomUUID()}` }, businessKey);

/** Draft, approve and publish a breach runbook; answers its words. */
export const publishRunbook = async (
  version: string,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<string> => {
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

export const drill = async (
  incidentId: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await as(
    token,
    'privacy.draft_breach_notices',
    { operationId: `c81d-${randomUUID()}`, incidentId, ...recipients(overrides) },
    businessKey,
  );

export const drillAudits = (businessId: string): Promise<readonly { readonly n: number }[]> =>
  harness.world.db.app.withBusiness(businessId, (tx) =>
    tx.query<{ readonly n: number }>(
      `select count(*)::int as n from public.audit_events
        where command = 'privacy.draft_breach_notices'`,
    ),
  );

/** What a business holds that a drill must never write. */
export interface Written {
  readonly incidents: number;
  readonly versions: number;
  readonly operations: number;
}

export const writes = (businessId: string): Promise<readonly Written[]> =>
  harness.world.db.app.withBusiness(businessId, (tx) =>
    tx.query<Written>(
      `select (select count(*)::int from public.privacy_incidents) as incidents,
              (select count(*)::int from public.legal_document_versions) as versions,
              (select count(*)::int from public.operations) as operations`,
    ),
  );

/** Opens the world a file of these cases reads, under `name`. */
export async function openDrill(name: string): Promise<void> {
  harness = await createHarness(name);
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
}

export async function closeDrill(): Promise<void> {
  await harness?.close();
}

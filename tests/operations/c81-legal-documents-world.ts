// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C81 legal-document cases share (`c81-legal-documents.test.ts`
// and `c81-legal-documents-access.test.ts`): each file opens its own.
//
// Ada is alpha's owner and holds `privacy:manage`; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds `privacy:manage`
// there. A client of alpha holds a share and nothing else, and the agent acts
// under a live delegation from Ada.

import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, type Answer } from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const CANARY = 'CANARY-c81-unpublished-draft-7e20c4';

export type Name = 'legal.draft_version' | 'legal.approve_version' | 'legal.publish_version';
export const NAMES: readonly Name[] = [
  'legal.draft_version',
  'legal.approve_version',
  'legal.publish_version',
];

/** The route of an operation, as `pathOf` in the surface builds it. */
export const pathOf = (name: Name): string => `/${name.replace('.', '/')}`;

/** The public address of a document's published version. */
export const publicPath = (businessKey: string, document: string): string =>
  `/api/public/b/${businessKey}/legal/${document}`;

export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
export const member = (caller: unknown): Member => caller as Member;

/** A made-up version label no other case in this file uses. */
let minor = 0;
export const nextVersion = (): string => `1.${String((minor += 1))}`;

/** A draft as the cases send it: the fields below, and any override. */
export interface DraftBody {
  readonly [field: string]: unknown;
  readonly operationId: string;
  readonly document: string;
  readonly version: string;
  readonly body: string;
}

export const draftBody = (overrides: Readonly<Record<string, unknown>> = {}): DraftBody => ({
  operationId: `c81-${randomUUID()}`,
  document: 'privacy-policy',
  version: nextVersion(),
  body: `# Privacy policy\n\nMade-up text ${randomUUID()}.\n`,
  ...overrides,
});

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

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

export const draft = async (
  body: Readonly<Record<string, unknown>> = draftBody(),
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> => await as(token, 'legal.draft_version', body, businessKey);

export const approve = async (
  versionId: unknown,
  digest: unknown,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await as(
    token,
    'legal.approve_version',
    { operationId: `c81-${randomUUID()}`, versionId, digest },
    businessKey,
  );

export const publish = async (
  versionId: unknown,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await as(
    token,
    'legal.publish_version',
    { operationId: `c81-${randomUUID()}`, versionId },
    businessKey,
  );

/** Draft, approve and publish one version; answers its id and body. */
export const released = async (
  overrides: Readonly<Record<string, unknown>> = {},
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<{ readonly versionId: string; readonly body: DraftBody }> => {
  const body = draftBody(overrides);
  const drafted = await draft(body, token, businessKey);
  expect(drafted.code, 'drafted').toBe('ok');
  const versionId = detailOf(drafted)['versionId'];
  expect((await approve(versionId, digestOf(String(body.body)), token, businessKey)).code).toBe(
    'ok',
  );
  expect((await publish(versionId, token, businessKey)).code, 'published').toBe('ok');
  return { versionId: String(versionId), body };
};

export const readPublic = async (
  businessKey: string,
  document: string,
): Promise<{ readonly status: number; readonly text: string }> => {
  const response = await harness.world.api.request(publicPath(businessKey, document));
  return { status: response.status, text: await response.text() };
};

/** How many versions a business holds, and how many are approved and published. */
export interface VersionCounts {
  readonly n: number;
  readonly approved: number;
  readonly published: number;
}

export const versionRows = async (businessId: string): Promise<readonly VersionCounts[]> =>
  await harness.world.db.app.withBusiness(businessId, (tx) =>
    tx.query<VersionCounts>(
      `select count(*)::int as n, count(approved_at)::int as approved,
              count(published_at)::int as published
         from public.legal_document_versions`,
    ),
  );

/** Opens the world a file of these cases reads, under `name`. */
export async function openLegal(name: string): Promise<void> {
  harness = await createHarness(name);
  const { world } = harness;
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, member(world.noah), 'read', WHOLE_BUSINESS, false, 'operations');
  });
  await world.db.app.withBusiness(world.bravo, async (tx) => {
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

export async function closeLegal(): Promise<void> {
  await harness?.close();
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C81 register cases share (`c81-register.test.ts` and
// `c81-register-isolation.test.ts`): each file opens its own, so the two never
// see each other's register.
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

export const CANARY = 'CANARY-c81-register-to-confirm-5b91e2';

export const SET = '/privacy/set_overseas_service';

export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
export const member = (caller: unknown): Member => caller as Member;

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

/** A made-up version label no other case in this file uses. */
let minor = 0;
export const nextVersion = (): string => `1.${String((minor += 1))}`;

/** A made-up register row, in use and confirmed unless overridden. */
/** A register row as the cases send it: the fields below, and any override. */
export interface SentRow {
  readonly [field: string]: unknown;
  readonly operationId: string;
  readonly service: string;
  readonly receives: string;
  readonly where: string;
  readonly trainsOnIt: string;
  readonly contract: string;
  readonly toConfirm: boolean;
  readonly inUse: boolean;
}

export const row = (overrides: Readonly<Record<string, unknown>> = {}): SentRow => ({
  operationId: `c81r-${randomUUID()}`,
  service: `Made-up service ${randomUUID().slice(0, 8)}`,
  receives: 'recipient address and name',
  where: 'Japan and the United States',
  trainsOnIt: 'no',
  contract: 'the provider business terms',
  toConfirm: false,
  inUse: true,
  ...overrides,
});

/** The fields of a row as the public policy lists it. */
/** A row as the public policy lists it. */
export interface ListedRow {
  readonly service: string;
  readonly receives: string;
  readonly where: string;
  readonly trainsOnIt: string;
  readonly contract: string;
}

export const listed = (sent: SentRow): ListedRow => ({
  service: sent.service,
  receives: sent.receives,
  where: sent.where,
  trainsOnIt: sent.trainsOnIt,
  contract: sent.contract,
});

export let harness: Harness;
export let credential: string;
export let clientToken: string;

export const set = async (
  body: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await call(harness.world.api, personPath(businessKey, SET), body, bearer(token));

/** Set a row and expect it applied. */
export const setOk = async (
  body: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> => {
  const answer = await set(body, token, businessKey);
  expect(answer.status, 'set').toBe(200);
  return answer;
};

export const draft = async (
  document: string = 'privacy-policy',
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Drafted> => {
  const body = `# ${document}\n\nMade-up text ${randomUUID()}.\n`;
  const answer = await call(
    harness.world.api,
    personPath(businessKey, '/legal/draft_version'),
    { operationId: `c81r-${randomUUID()}`, document, version: nextVersion(), body },
    bearer(token),
  );
  expect(answer.status, 'drafted').toBe(200);
  return { versionId: String(detailOf(answer)['versionId']), body };
};

/** A drafted version: its id and the body the owner reads. */
export interface Drafted {
  readonly versionId: string;
  readonly body: string;
}

export const approve = async (
  drafted: Drafted,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath(businessKey, '/legal/approve_version'),
    {
      operationId: `c81r-${randomUUID()}`,
      versionId: drafted.versionId,
      digest: digestOf(drafted.body),
    },
    bearer(token),
  );

export const publish = async (
  versionId: string,
  token: string = harness.world.ada.token,
  businessKey: string = 'alpha',
): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath(businessKey, '/legal/publish_version'),
    { operationId: `c81r-${randomUUID()}`, versionId },
    bearer(token),
  );

/** Draft, approve and publish a privacy policy; answers what the public reads. */
export const releasePolicy = async (
  token: string = harness.world.ada.token,
  businessKey = 'alpha',
): Promise<PolicyRead> => {
  const drafted = await draft('privacy-policy', token, businessKey);
  expect((await approve(drafted, token, businessKey)).status, 'approved').toBe(200);
  expect((await publish(drafted.versionId, token, businessKey)).status, 'published').toBe(200);
  return await readPolicy(businessKey);
};

/** The public privacy policy as the cases read it. */
export interface PolicyRead {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

export const readPolicy = async (businessKey: string = 'alpha'): Promise<PolicyRead> => {
  const response = await harness.world.api.request(
    `/api/public/b/${businessKey}/legal/privacy-policy`,
  );
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
};

export const registerRows = async (
  businessId: string,
): Promise<readonly { readonly row: string }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(s)::text as row from public.overseas_services s order by s.id`,
      ),
  );

/** Opens the world a file of these cases reads, under `name`. */
export async function openRegister(name: string): Promise<void> {
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

export async function closeRegister(): Promise<void> {
  await harness?.close();
}

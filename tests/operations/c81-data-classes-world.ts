// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C81 data-class cases share (`c81-data-classes.test.ts` and
// `c81-data-classes-isolation.test.ts`): each file opens its own, so the two
// never see each other's register.
//
// Ada is alpha's owner and holds `privacy:manage`; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds `privacy:manage`
// there. A client of alpha holds a share and nothing else, and the agent acts
// under a live delegation from Ada. Every class is made up.

import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, type Answer } from '../acceptance/world.ts';
import type { ListedDataClass } from '../../packages/core-records/src/operations/data-classes.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const SET = '/privacy/set_data_class';
export const FIELDS = ['dataClass', 'purpose', 'disclosures', 'retention', 'deletion'] as const;

export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const member = (caller: unknown) => caller as Member;

let minor = 0;
const nextVersion = () => `3.${String((minor += 1))}`;

/** A class as a case sends it; an override may make any field malformed. */
export interface SentClass {
  readonly operationId: string;
  readonly dataClass: string;
  readonly purpose: string;
  readonly disclosures: string;
  readonly retention: string;
  readonly deletion: string;
  readonly inUse: boolean;
}

/** A policy's public read. */
export interface PolicyRead {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

/** A made-up class, in use unless overridden. */
export const dataClass = (overrides: Readonly<Record<string, unknown>> = {}): SentClass =>
  ({
    operationId: `c81d-${randomUUID()}`,
    dataClass: `Made-up class ${randomUUID().slice(0, 8)}`,
    purpose: 'to deliver the work the client hired us for',
    disclosures: 'the outside services on the overseas register, and no one else',
    retention: 'seven years after the last invoice',
    deletion: 'deleted from records and search, then from backups as they roll off',
    inUse: true,
    ...overrides,
  }) as SentClass;

/** The fields of a class as the public policy lists it. */
export const listed = (sent: SentClass): ListedDataClass => ({
  dataClass: sent.dataClass,
  purpose: sent.purpose,
  disclosures: sent.disclosures,
  retention: sent.retention,
  deletion: sent.deletion,
});

const state: { harness?: Harness; credential: string; clientToken: string } = {
  credential: '',
  clientToken: '',
};

/** This file's world, once `openWorld` has made it. */
export function h(): Harness {
  if (state.harness === undefined) throw new Error('c81 data classes: the world is not open');
  return state.harness;
}
export const credential = (): string => state.credential;
export const clientToken = (): string => state.clientToken;

export async function openWorld(name: string): Promise<void> {
  const harness = await createHarness(name);
  state.harness = harness;
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
  state.clientToken = await tokenFor(client.presented.subject);
  const { decided } = await harness.approvedReservation();
  expect(decided.code, 'the decision a pickup needs').toBe('ok');
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  expect(picked.code, 'the pickup').toBe('ok');
  state.credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
}

export async function closeWorld(): Promise<void> {
  await state.harness?.close();
}

export const set = async (
  body: object,
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<Answer> => await call(h().world.api, personPath(key, SET), body, bearer(token));

export async function setOk(
  body: object,
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<Answer> {
  const answer = await set(body, token, key);
  expect(answer.status, 'set').toBe(200);
  return answer;
}

const legal = async (path: string, body: object, token: string, key: string) =>
  await call(
    h().world.api,
    personPath(key, `/legal/${path}`),
    { operationId: `c81d-${randomUUID()}`, ...body },
    bearer(token),
  );

export async function draft(
  document = 'privacy-policy',
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<{ readonly versionId: string; readonly body: string }> {
  const body = `# ${document}\n\nMade-up text ${randomUUID()}.\n`;
  const answer = await legal(
    'draft_version',
    { document, version: nextVersion(), body },
    token,
    key,
  );
  expect(answer.status, 'drafted').toBe(200);
  const detail = answer.body['detail'] as Record<string, unknown>;
  return { versionId: String(detail['versionId']), body };
}

export const approve = async (
  drafted: { readonly versionId: string; readonly body: string },
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await legal(
    'approve_version',
    { versionId: drafted.versionId, digest: digestOf(drafted.body) },
    token,
    key,
  );

export const publish = async (
  versionId: string,
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<Answer> => await legal('publish_version', { versionId }, token, key);

export async function readPolicy(key = 'alpha'): Promise<PolicyRead> {
  const response = await h().world.api.request(`/api/public/b/${key}/legal/privacy-policy`);
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

export async function releasePolicy(
  token: string = h().world.ada.token,
  key = 'alpha',
): Promise<PolicyRead> {
  const drafted = await draft('privacy-policy', token, key);
  expect((await approve(drafted, token, key)).status, 'approved').toBe(200);
  expect((await publish(drafted.versionId, token, key)).status, 'published').toBe(200);
  return await readPolicy(key);
}

export const classRows = async (businessId: string): Promise<readonly { readonly row: string }[]> =>
  await h().world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(c)::text as row from public.data_classes c order by c.id`,
      ),
  );

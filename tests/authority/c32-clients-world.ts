// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `c32-clients-and-grants.test.ts` opens: its stand-ins, callers and helpers, split from
// that file to keep it under the line limit. Its hooks are called at module
// level there, under the same skip as its cases.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import {
  enrol,
  grantTo,
  shareWithClient,
  WHOLE_BUSINESS,
  type Member,
} from '../commands/fixture.ts';

export const CANARY = 'CANARY-c32-client-record-7d13a0';

if (serverUrl === undefined) {
  console.warn('authority/c32-clients-and-grants: DATABASE_URL is unset, so nothing below ran.');
}

/** A world caller as the fixture's member, which carries the same ids. */
export const member = (caller: unknown): Member => caller as Member;

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

export const outcome = (answer: Answer): { readonly status: number; readonly code: string } => ({
  status: answer.status,
  code: answer.code,
});

export let harness: Harness;
export let tia: Member;
export let tiaToken: string;
export let clientToken: string;
export let credential: string;

export const as = async (
  path: string,
  body: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  businessKey = 'alpha',
): Promise<Answer> =>
  await call(harness.world.api, personPath(businessKey, path), body, bearer(token));

export const createClient = async (
  name: string,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<string> => {
  const answer = await as('/client/create', { operationId: randomUUID(), name }, token, key);
  expect(outcome(answer), `create ${name}`).toEqual({ status: 200, code: 'ok' });
  return String(detailOf(answer)['clientId']);
};

export const give = async (
  body: Readonly<Record<string, unknown>>,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> => await as('/access/grant', { operationId: randomUUID(), ...body }, token, key);

export const revoke = async (
  grantId: unknown,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await as('/access/revoke', { operationId: randomUUID(), grantId }, token, key);

export const listClients = async (token: string, key = 'alpha'): Promise<Answer> =>
  await as('/client/list', {}, token, key);

export const previewOf = async (
  personId: string,
): Promise<{ readonly permissions: unknown[] | undefined; readonly clientRecords: unknown }> => {
  const answer = await as('/access/read', {});
  expect(answer.status, 'access.read').toBe(200);
  const team = answer.body['team'] as readonly { personId: string; permissions: unknown[] }[];
  return {
    permissions: team.find((person) => person.personId === personId)?.permissions,
    clientRecords: answer.body['clientRecords'],
  };
};

/** Every grant and client row of a business, to show a refusal wrote nothing. */
export const rowsOf = async (businessId: string): Promise<readonly { readonly row: string }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(g)::text as row from public.grants g
       union all select to_jsonb(c)::text from public.clients c
       order by 1`,
      ),
  );

export async function openClientsWorld(): Promise<void> {
  harness = await createHarness('c32_clients');
  const { world } = harness;
  tia = await enrol(world.db.app, world.alpha, 'tia');
  tiaToken = await tokenFor(tia.presented.subject);
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    await grantTo(tx, member(world.bea), 'manage', WHOLE_BUSINESS, false, 'access');
    await grantTo(tx, member(world.bea), 'write', WHOLE_BUSINESS, false, 'record');
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

export async function closeClientsWorld(): Promise<void> {
  await harness?.close();
}

/** The hooks a test file opening this world calls at module level, under its cases' skip. */
export function useClientsWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await openClientsWorld();
  }, 120_000);
  afterAll(async () => {
    if (serverUrl === undefined) return;
    await closeClientsWorld();
  });
}

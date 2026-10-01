// SPDX-License-Identifier: AGPL-3.0-only
//
// The world API-2's tests share: Ada is alpha's owner; Noah holds `task:read`,
// `task:write` and `credential:write` in alpha; Mia holds neither key; Bea is
// a member of bravo holding `credential:write` there. A client of alpha holds
// a share and nothing else, and the pickup agent acts under a live delegation
// from Ada. Each test file calls `openWorld()` and gets a harness of its own.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const CANARY: string = 'CANARY-api2-credential-purpose-3c81f0';
export const DAY_MS: number = 24 * 60 * 60 * 1000;

const member = (caller: unknown): Member => caller as Member;
export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

export let harness: Harness;
export let credential: string;
export let clientToken: string;

/** A valid issue body: task read and write, 30 days out; `overrides` replaces any field. */
export const issueBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  operationId: `api2-${randomUUID()}`,
  scope: [
    { collection: 'task', action: 'read' },
    { collection: 'task', action: 'write' },
  ],
  expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  purpose: `the command line on my laptop ${randomUUID()}`,
  ...overrides,
});

export const issue = async (
  body: Readonly<Record<string, unknown>> = issueBody(),
  token: string = harness.world.ada.token,
  businessKey = 'alpha',
): Promise<Answer> =>
  await call(harness.world.api, personPath(businessKey, '/credential/issue'), body, bearer(token));

export const revoke = async (
  credentialId: unknown,
  token: string = harness.world.ada.token,
  businessKey = 'alpha',
): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath(businessKey, '/credential/revoke'),
    { operationId: `api2-${randomUUID()}`, credentialId },
    bearer(token),
  );

/** Every credential row, audit event and register row of the two commands, as text. */
export const stored = async (businessId: string): Promise<string> =>
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const rows = await tx.query<{ readonly row: string }>(
      `select to_jsonb(c)::text as row from public.agent_credentials c
       union all
       select to_jsonb(e)::text from public.audit_events e
        where command in ('credential.issue', 'credential.revoke')
       union all
       select to_jsonb(o)::text from public.operations o
        where command in ('credential.issue', 'credential.revoke')`,
    );
    return rows.map((one) => one.row).join('\n');
  });

export const credentialCount = async (businessId: string): Promise<number> =>
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const rows = await tx.query<{ readonly n: number }>(
      'select count(*)::int as n from public.agent_credentials',
    );
    return rows[0]?.n ?? -1;
  });

/** Opens the world for one test file: its own harness, grants and share. */
export function openWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    harness = await createHarness('api2_credential');
    const { world } = harness;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, member(world.noah), 'read', WHOLE_BUSINESS, false, 'task');
      await grantTo(tx, member(world.noah), 'write', WHOLE_BUSINESS, false, 'task');
      await grantTo(tx, member(world.noah), 'write', WHOLE_BUSINESS, false, 'credential');
    });
    // Bea holds the key in bravo, so her revocation there reaches the row lookup
    // and proves the business boundary, not the key gate.
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, member(world.bea), 'write', WHOLE_BUSINESS, false, 'credential');
    });
    const client = await shareWithClient(
      world.db.app,
      world.alpha,
      member(world.ada),
      harness.alphaTask.id,
    );
    clientToken = await tokenFor(client.presented.subject);
    const { decided } = await harness.approvedReservation();
    const reservationId = detailOf(decided)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    credential = String(detailOf(picked)['credential']);
  }, 120_000);

  afterAll(async () => {
    if (serverUrl !== undefined) await harness?.close();
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// What the C55 operations-view cases share (`c55-operations-view.test.ts`):
// the incident they send, the view they read back, and the keys the world
// needs before the first case. Noah holds `operations:read` alone in alpha;
// Bea holds both keys in bravo. A client of alpha holds a share, and the agent
// acts under a live delegation from Ada.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import type { Harness } from '../acceptance/role-case-harness.ts';
import type { Answer } from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

/** A valid incident, found an hour ago; `overrides` replaces any field. */
/** An incident as the cases send it: the fields below, and any override. */
export interface IncidentBody {
  readonly [field: string]: unknown;
  readonly operationId: string;
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly string[];
}

export const incident = (overrides: Readonly<Record<string, unknown>> = {}): IncidentBody => ({
  operationId: `c55-${randomUUID()}`,
  whatHappened: 'A client folder link reached the wrong person.',
  foundAt: new Date(Date.now() - 3_600_000).toISOString(),
  foundBy: 'The second operator',
  affected: 'One client; two of their customers.',
  informationKinds: ['contact'],
  ...overrides,
});

export interface IncidentView {
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
export const pathOf = (name: 'operations.read' | 'privacy.record_incident') =>
  `/${name.replace('.', '/')}`;

/** A world caller as the fixture's member, which carries the same ids. */
export const member = (caller: unknown) => caller as Member;

export const incidentsOf = (answer: Answer): readonly IncidentView[] =>
  (answer.body['privacyIncidents'] ?? []) as readonly IncidentView[];

/** The keys and the share the cases need, and the client's and the agent's credentials. */
export async function c55Keys(
  harness: Harness,
): Promise<{ readonly credential: string; readonly clientToken: string }> {
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
  const clientToken = await tokenFor(client.presented.subject);

  const { decided } = await harness.approvedReservation();
  expect(decided.code, 'the decision a pickup needs').toBe('ok');
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  expect(picked.code, 'the pickup').toBe('ok');
  const credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
  return { credential, clientToken };
}

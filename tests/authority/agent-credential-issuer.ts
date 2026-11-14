// SPDX-License-Identifier: AGPL-3.0-only
//
// An issuer of agent credentials for the database-bound tests beside this
// file: a fresh member of alpha holding `task:read`, `task:write` and
// `credential:write` across the business, the grant ids kept so a test can
// revoke one, and `credential.issue` called through the person entry.

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { World } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const DAY_MS: number = 24 * 60 * 60 * 1000;

export interface Issuer extends Member {
  /** Grant ids by `collection:action`. */
  readonly grants: Readonly<Record<string, string>>;
}

/** A fresh member of alpha holding `task:read`, `task:write` and `credential:write`. */
export async function issuerIn(world: World): Promise<Issuer> {
  const member = await enrol(world.db.app, world.alpha, `issuer-${randomUUID().slice(0, 6)}`);
  const grants = await world.db.app.withBusiness(world.alpha, async (tx) => ({
    'task:read': await grantTo(tx, member, 'read', WHOLE_BUSINESS),
    'task:write': await grantTo(tx, member, 'write', WHOLE_BUSINESS),
    'credential:write': await grantTo(tx, member, 'write', WHOLE_BUSINESS, false, 'credential'),
  }));
  return { ...member, grants };
}

/** An issue body for task read and write, 30 days out; `overrides` replaces any field. */
export const issueBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  operationId: randomUUID(),
  scope: [
    { collection: 'task', action: 'read' },
    { collection: 'task', action: 'write' },
  ],
  expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  purpose: 'the command line on a laptop',
  ...overrides,
});

/** `credential.issue` through the person entry, on `database` (the world's own by default). */
export const issueAs = async (
  world: World,
  issuer: Member,
  body: Readonly<Record<string, unknown>>,
  database: Database = world.db.app,
): Promise<CommandResult> =>
  await executeCommand(database, world.alpha, issuer.presented, 'api', {
    command: 'credential.issue',
    ...body,
  });

/** The agent credentials `issuer` holds in alpha, read past the tenancy wrapper. */
export const credentialsOf = async (
  world: World,
  issuer: Member,
): Promise<readonly { readonly issued_at: Date; readonly expires_at: Date }[]> =>
  await world.db.admin.execute<{ readonly issued_at: Date; readonly expires_at: Date }>(
    `select issued_at, expires_at from public.agent_credentials where issued_by_person_id = $1`,
    [issuer.personId],
  );

export const detailOf = (answer: unknown): Readonly<Record<string, unknown>> =>
  (answer as { readonly detail?: Readonly<Record<string, unknown>> }).detail ?? {};

export const codeOf = (answer: unknown): unknown => (answer as { readonly code?: unknown }).code;

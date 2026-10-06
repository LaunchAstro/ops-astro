// SPDX-License-Identifier: AGPL-3.0-only
//
// The role-case matrix's positive bodies for setup's commands: custody (C31)
// and the connector fleet (MP-14-7a).
// `tableBody` answers these, the fixed literals (`role-case-fixed-bodies.ts`)
// and team invitations (C39-T, `role-case-invitation-bodies.ts`)
// in one call from `role-case-positive-body.ts`, so that file stays under the
// per-file cap.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';
import { FIXED_BODIES } from './role-case-fixed-bodies.ts';
import { invitationBody, isInvitation } from './role-case-invitation-bodies.ts';

type Body = { readonly body: Readonly<Record<string, unknown>> } | undefined;

/** What these recipes need from the world: `BodyContext`'s person and inviter. */
export interface SetupContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  freshInviter?(): Promise<void>;
  /** A broken connection to repair, owner-written; absent, a made-up id is named. */
  brokenConnection?(): Promise<string>;
  /** MP-14-10a: a new client with one `ready` graduation row, owner-written. */
  readyClass?(): Promise<{ readonly clientId: string; readonly classId: string }>;
}

/** Custody (C31): the admin lists, sets a key and clears one it set. */
async function custodyBody(name: CommandName, context: SetupContext): Promise<Body> {
  switch (name) {
    case 'secret.list':
      return { body: {} };
    case 'secret.set':
      return { body: { name: 'matrix.key', value: `matrix-${randomUUID()}` } };
    case 'secret.clear': {
      const set = await context.asPerson('secret.set', {
        name: `matrix.clear-${randomUUID().slice(0, 8)}`,
        value: `matrix-${randomUUID()}`,
      });
      return {
        body: { secretId: String((set.body['detail'] as Record<string, unknown>)['secretId']) },
      };
    }
    default:
      return undefined;
  }
}

/** A fixed literal's, a setup command's or an invitation's positive body; undefined otherwise. */
export async function tableBody(name: CommandName, context: SetupContext): Promise<Body> {
  const fixed = FIXED_BODIES[name];
  if (fixed !== undefined) return { body: { ...fixed } };
  if (isInvitation(name)) return await invitationBody(name, context);
  // The connector fleet (MP-14-7a): the admin reads it and starts a repair.
  if (name === 'connection.fleet' || name === 'connection.signal') return { body: {} };
  // The graduation region (MP-14-10a): the admin reads it.
  if (name === 'connection.graduation') return { body: {} };
  if (name === 'connector.repair') {
    return { body: { connectionId: (await context.brokenConnection?.()) ?? randomUUID() } };
  }
  if (MANDATE_COMMANDS.has(name)) return await mandateBody(name, context);
  return await custodyBody(name, context);
}

const MANDATE_COMMANDS: ReadonlySet<CommandName> = new Set([
  'mandate.file',
  'mandate.revoke',
  'graduation.promote',
  'graduation.demote',
]);

/** MP-14-10a: the admin holds `mandate:manage` and signs in with a second factor. */
async function mandateBody(name: CommandName, context: SetupContext): Promise<Body> {
  const ceiling = { amountMinor: 100, currency: 'AUD' };
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const made = await context.readyClass?.();
  // Absent the hook (external-party item 3), each names a made-up id, as
  // `connector.repair` does, and sets nothing up first.
  if (made === undefined) return { body: madeUpMandateBody(name, ceiling, expiresAt) };
  const filing = { clientId: made.clientId, classes: ['social.post'], ceiling, expiresAt };
  const promoting = { classId: made.classId, ceiling, expiresAt };
  if (name === 'mandate.file') return { body: { ...filing, label: 'The matrix files one' } };
  if (name === 'graduation.promote') return { body: promoting };
  if (name === 'graduation.demote') {
    await context.asPerson('graduation.promote', promoting);
    return { body: { classId: made.classId } };
  }
  const filed = await context.asPerson('mandate.file', { ...filing, label: 'To be revoked' });
  return {
    body: { mandateId: String((filed.body['detail'] as Record<string, unknown>)['mandateId']) },
  };
}

/** A well-formed body naming a made-up client, class or mandate. */
function madeUpMandateBody(
  name: CommandName,
  ceiling: Readonly<Record<string, unknown>>,
  expiresAt: string,
): Readonly<Record<string, unknown>> {
  switch (name) {
    case 'mandate.file':
      return {
        clientId: randomUUID(),
        classes: ['social.post'],
        ceiling,
        expiresAt,
        label: 'The matrix files one',
      };
    case 'graduation.promote':
      return { classId: randomUUID(), ceiling, expiresAt };
    case 'graduation.demote':
      return { classId: randomUUID() };
    default:
      return { mandateId: randomUUID() };
  }
}

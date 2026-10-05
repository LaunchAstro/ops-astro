// SPDX-License-Identifier: AGPL-3.0-only
//
// The role-case matrix's positive bodies for setup's commands: custody (C31).
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
  return await custodyBody(name, context);
}

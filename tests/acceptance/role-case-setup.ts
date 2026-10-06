// SPDX-License-Identifier: AGPL-3.0-only
//
// The role-case matrix's positive bodies for setup's commands: custody (C31)
// and the connector fleet (MP-14-7a). `tableBody` answers these, the fixed
// literals (`role-case-fixed-bodies.ts`), team invitations (C39-T,
// `role-case-invitation-bodies.ts`) and C80's live correction (`c80-bodies.ts`)
// in one call from `role-case-positive-body.ts`, so that file stays under the
// per-file cap.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';
import { FIXED_BODIES } from './role-case-fixed-bodies.ts';
import { C80_NAMES, c80PositiveBody } from './c80-bodies.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';
import { invitationBody, isInvitation } from './role-case-invitation-bodies.ts';

type Body = { readonly body: Readonly<Record<string, unknown>> } | undefined;

/** What these recipes need from the world: `BodyContext`'s person and inviter. */
export interface SetupContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  freshInviter?(): Promise<void>;
  /** A broken connection to repair, owner-written; absent, a made-up id is named. */
  brokenConnection?(): Promise<string>;
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

/** A fixed literal's, a setup command's, an invitation's or C80's positive body; else undefined. */
export async function tableBody(name: CommandName, context: BodyContext): Promise<Body | Prepared> {
  const fixed = FIXED_BODIES[name];
  if (fixed !== undefined) return { body: { ...fixed } };
  if (isInvitation(name)) return await invitationBody(name, context);
  if (C80_NAMES.has(name)) return await c80PositiveBody(name, context);
  // The connector fleet (MP-14-7a): the admin reads it and starts a repair.
  if (name === 'connection.fleet' || name === 'connection.signal') return { body: {} };
  // The graduation region (MP-14-10a): the admin reads it.
  if (name === 'connection.graduation') return { body: {} };
  if (name === 'connector.repair') {
    return { body: { connectionId: (await context.brokenConnection?.()) ?? randomUUID() } };
  }
  return await custodyBody(name, context);
}

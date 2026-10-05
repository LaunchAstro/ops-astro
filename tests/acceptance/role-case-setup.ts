// SPDX-License-Identifier: AGPL-3.0-only
//
// The role-case matrix's positive bodies for setup's commands: custody (C31).
// `tableBody` answers these and the fixed literals (`role-case-fixed-bodies.ts`)
// in one call from `role-case-positive-body.ts`, so that file stays under the
// per-file cap.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';
import { FIXED_BODIES } from './role-case-fixed-bodies.ts';

type Body = { readonly body: Readonly<Record<string, unknown>> } | undefined;

/** What these recipes need from the world: `BodyContext`'s person. */
interface SetupContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
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

/** A fixed literal's or a setup command's positive body; undefined for every other command. */
export async function tableBody(name: CommandName, context: SetupContext): Promise<Body> {
  const fixed = FIXED_BODIES[name];
  if (fixed !== undefined) return { body: { ...fixed } };
  return await custodyBody(name, context);
}

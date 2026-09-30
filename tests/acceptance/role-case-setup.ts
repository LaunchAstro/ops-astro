// SPDX-License-Identifier: AGPL-3.0-only
//
// The role-case matrix's positive bodies for setup's commands: custody (C31),
// connections and signal (MP-14-7a, MP-14-8, MP-14-10a), automations (C33,
// C52-A) and onboarding (C41-A). One call from `role-case-positive-body.ts`,
// so that file stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { automationsBody, type AutomationsContext } from './role-case-automations.ts';
import { connectionsBody, type ConnectionsContext } from './role-case-connections.ts';
import { onboardingBody, type OnboardingContext } from './role-case-onboarding.ts';

type Body = { readonly body: Readonly<Record<string, unknown>> } | undefined;

/** Custody (C31): the admin lists, sets a key and clears one it set. */
async function custodyBody(name: CommandName, context: OnboardingContext): Promise<Body> {
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

/** A setup command's positive body, or undefined for every other command. */
export async function setupBody(
  name: CommandName,
  context: AutomationsContext & ConnectionsContext & OnboardingContext,
): Promise<Body> {
  return (
    (await custodyBody(name, context)) ??
    (await connectionsBody(name, context)) ??
    (await automationsBody(name, context)) ??
    (await onboardingBody(name, context))
  );
}

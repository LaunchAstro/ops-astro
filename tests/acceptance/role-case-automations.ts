// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for Settings ▸ Workflow triggers (C33): the
// registry, a release of a new definition, and a manual activation on a
// version the admin has just released through the route. Any other name goes
// on to the Wayfinder recipes, whose lookup throws for a name with none.
//
// A harness, not a suite: nothing here runs on its own.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext } from './role-case-bodies.ts';
import { wayfinderBody } from './role-case-wayfinder.ts';

type Body = Record<string, unknown>;

const RELEASE = {
  name: 'the matrix releases an automation',
  kind: 'automation',
  contentDigest: 'd'.repeat(64),
  contentSize: 1,
  inputs: [],
  operations: [],
  modes: ['manual'],
} as const;

/** A version the context's person releases, to pin an activation to. */
async function releasedVersion(context: BodyContext): Promise<string> {
  const released = await context.asPerson('definition.release', RELEASE);
  if (released.code !== 'ok')
    throw new Error(`matrix: definition.release refused ${released.code}`);
  return String((released.body['detail'] as Body)['versionId']);
}

/** The recipe's body for `name`: an automation's here, any other name's in Wayfinder's. */
export async function laterBody(
  name: CommandName,
  context: BodyContext,
  target: () => Promise<Body>,
): Promise<Body> {
  switch (name) {
    case 'automation.registry':
      return {};
    case 'definition.release':
      return { ...RELEASE };
    case 'activation.change':
      return { versionId: await releasedVersion(context), mode: 'manual', enabled: false };
    default:
      return await wayfinderBody(name, context, target);
  }
}

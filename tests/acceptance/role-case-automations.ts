// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for Settings ▸ Workflow triggers (C33): the
// registry, a release of a new definition, and a manual activation on a
// version the admin has just released through the route; and for its standing
// approvals (C52-A): an enabled activation pinning version 1 of two, adopted,
// rolled back, turned off or its approval revoked. Every row is written
// through the routes. Any other name goes on to the Wayfinder recipes, whose
// lookup throws for a name with none.
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

/** The context's person sends `name`, and the answer's detail, or the recipe throws. */
async function detailOf(context: BodyContext, name: CommandName, body: Body): Promise<Body> {
  const answer = await context.asPerson(name, body);
  if (answer.code !== 'ok') throw new Error(`matrix: ${name} refused ${answer.code}`);
  return answer.body['detail'] as Body;
}

/** A version the context's person releases, to pin an activation to. */
async function releasedVersion(context: BodyContext): Promise<string> {
  return String((await detailOf(context, 'definition.release', RELEASE))['versionId']);
}

/** An enabled manual activation pinning version 1 of a definition with two versions, at revision 1. */
async function pinnedFirst(context: BodyContext): Promise<Record<string, string>> {
  const released = await detailOf(context, 'definition.release', RELEASE);
  const first = String(released['versionId']);
  const on = await detailOf(context, 'activation.change', {
    versionId: first,
    mode: 'manual',
    enabled: true,
  });
  const { name: _name, kind: _kind, ...again } = RELEASE;
  const next = await detailOf(context, 'definition.release', {
    ...again,
    definitionId: String(released['definitionId']),
  });
  return { activationId: String(on['activationId']), first, second: String(next['versionId']) };
}

/** Version 1 adopted, then version 2: the activation at revision 3, version 2's approval standing. */
async function adoptedBoth(context: BodyContext): Promise<Record<string, string>> {
  const pinned = await pinnedFirst(context);
  const { activationId } = pinned;
  await detailOf(context, 'activation.adopt', {
    activationId,
    versionId: pinned['first'],
    expectedRevision: 1,
  });
  const second = await detailOf(context, 'activation.adopt', {
    activationId,
    versionId: pinned['second'],
    expectedRevision: 2,
  });
  return { activationId: String(activationId), approvalId: String(second['approvalId']) };
}

/** C52-A's recipe for `name`, or undefined for any other name. */
async function approvalBody(name: CommandName, context: BodyContext): Promise<Body | undefined> {
  switch (name) {
    case 'activation.adopt': {
      const { activationId, second } = await pinnedFirst(context);
      return { activationId, versionId: second, expectedRevision: 1 };
    }
    case 'activation.roll_back':
      return { activationId: (await adoptedBoth(context))['activationId'], expectedRevision: 3 };
    case 'activation.turn_off':
      return { activationId: (await pinnedFirst(context))['activationId'], expectedRevision: 1 };
    case 'approval.revoke':
      return { approvalId: (await adoptedBoth(context))['approvalId'] };
    default:
      return undefined;
  }
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
      return (await approvalBody(name, context)) ?? (await wayfinderBody(name, context, target));
  }
}

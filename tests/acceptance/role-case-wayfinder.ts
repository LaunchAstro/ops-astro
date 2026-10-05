// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's Wayfinder recipes (WF-1): the minimal valid body for
// each map and ticket command, with the map it needs filed first through the
// routes. `role-case-positive-body.ts` calls `wayfinderBody` in its switch's
// default, which throws for a declaration with no recipe.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext } from './role-case-bodies.ts';
import { madeClient } from './role-case-access-bodies.ts';

type Target = () => Promise<Record<string, unknown>>;
type Body = Record<string, unknown>;
type Recipe = (context: BodyContext, target: Target) => Body | Promise<Body>;

/** A map filed by the context's person, and the revision it stands at. */
async function freshMap(
  context: BodyContext,
): Promise<{ recordId: string; expectedRevision: number }> {
  const made = await context.asPerson('task.create', {
    fields: { title: 'a map for the matrix' },
    taskType: 'map',
  });
  if (made.code !== 'ok') throw new Error(`matrix: task.create (map) refused ${made.code}`);
  return {
    recordId: String(made.body['recordId']),
    expectedRevision: Number(made.body['revision']),
  };
}

const WAYFINDER_BODIES: Partial<Record<CommandName, Recipe>> = {
  // An unguarded retype is `write` on the task.
  'task.set_type': async (_, target) => ({ ...(await target()), taskType: 'build' }),
  // A map's client change: an empty map and a client of this business (C32).
  'map.scope': async (context) => ({
    ...(await freshMap(context)),
    client: await madeClient(context),
  }),
  // A map's revision writes its version and components (P15).
  'map.revise': async (context) => ({
    ...(await freshMap(context)),
    notes: 'the admin revises it',
  }),
  'map.view': async (context) => ({ recordId: (await freshMap(context)).recordId }),
  'map.frontier': async (context) => ({ recordId: (await freshMap(context)).recordId }),
};

/** The recipe's body for `name`; a name with no recipe fails the matrix. */
export async function wayfinderBody(
  name: CommandName,
  context: BodyContext,
  target: Target,
): Promise<Body> {
  const recipe = WAYFINDER_BODIES[name];
  if (recipe === undefined)
    throw new Error(`matrix: no positive control recipe for ${String(name)}`);
  return await recipe(context, target);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's Wayfinder recipes (WF-1, WF-2): the minimal valid
// body for each map and ticket command, with the map or chart it needs filed
// first through the routes. `role-case-bodies.ts` reads this table in its
// switch's default, before it throws for a declaration with no recipe.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

/** The one thing these recipes need from the world: `BodyContext`'s person route. */
interface BodyContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

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
  if (made.code !== 'ok') throw new Error(`matrix: map create refused ${made.code}`);
  return {
    recordId: String(made.body['recordId']),
    expectedRevision: Number(made.body['revision']),
  };
}

/** A charted map with `count` research tickets and one fog patch, read back through the routes. */
async function chartedMap(
  context: BodyContext,
  count: number,
): Promise<{
  map: string;
  revision: number;
  patch: string;
  tickets: readonly string[];
  at: readonly { recordId: string; expectedRevision: number }[];
}> {
  const refs = Array.from({ length: count }, (_, index) => `t${String(index)}`);
  const made = await context.asPerson('map.chart', {
    title: 'a map for the matrix',
    tickets: refs.map((ref) => ({ ref, title: ref, type: 'research' })),
    fog: ['a patch'],
  });
  if (made.code !== 'ok') throw new Error(`matrix: map.chart refused ${made.code}`);
  const detail = made.body['detail'] as { tickets: Record<string, string> };
  const tickets = refs.map((ref) => detail.tickets[ref] as string);
  const frontier = await context.asPerson('map.frontier', { recordId: made.body['recordId'] });
  const fog = frontier.body['fog'] as readonly { id: string }[];
  // A fresh ticket stands at revision 1: nothing has written it since its create.
  return {
    map: String(made.body['recordId']),
    revision: Number(made.body['revision']),
    patch: String(fog[0]?.id),
    tickets,
    at: tickets.map((recordId) => ({ recordId, expectedRevision: 1 })),
  };
}

export const WAYFINDER_BODIES: Partial<Record<CommandName, Recipe>> = {
  // WF-1. An unguarded retype is `write` on the task; the three map rows need
  // a task of type map, filed through the route.
  'task.set_type': async (_, target) => ({ ...(await target()), taskType: 'build' }),
  'map.revise': async (context) => ({
    ...(await freshMap(context)),
    notes: 'the admin revises it',
  }),
  'map.scope': async (context) => ({ ...(await freshMap(context)), client: randomUUID() }),
  'map.view': async (context) => ({ recordId: (await freshMap(context)).recordId }),
  'map.frontier': async (context) => ({ recordId: (await freshMap(context)).recordId }),
  // WF-2, each on a map and ticket filed through the routes.
  'map.chart': () => ({
    title: 'a charted map',
    tickets: [{ ref: 'a', title: 'a ticket', type: 'research' }],
    fog: ['a patch'],
  }),
  'task.set_blocking': async (context) => {
    const chart = await chartedMap(context, 2);
    return { ...chart.at[1], blockedBy: [chart.tickets[0]] };
  },
  'task.claim': async (context) => (await chartedMap(context, 1)).at[0] ?? {},
  'task.resolve': async (context) => ({
    ...(await chartedMap(context, 1)).at[0],
    answer: 'found',
    gist: 'found it',
  }),
  'task.close_out_of_scope': async (context) => ({
    ...(await chartedMap(context, 1)).at[0],
    reason: 'not now',
  }),
  'map.graduate': async (context) => {
    const chart = await chartedMap(context, 0);
    return {
      recordId: chart.map,
      expectedRevision: chart.revision,
      patchId: chart.patch,
      tickets: [{ title: 'from the fog', type: 'task' }],
    };
  },
};

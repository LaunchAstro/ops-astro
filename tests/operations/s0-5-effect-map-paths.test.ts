// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on the path the positive fixtures miss for
// a map (wayfinder S7, #1297): each fixture writes on an ordinary task, but the
// ordinary task commands take a ticket too, and a write to a ticket's row or a
// link to it fires the records and links triggers that refresh its map's
// summary and frontier (`map_summary_on_record`, `map_summary_on_link`). Here
// each command's own positive recipe runs again with every fresh task it makes
// filed as an open, unassigned ticket under one live map. Each act runs alone,
// must refresh both tables, and must write nothing its entry does not declare.
// The map commands declare the read model already (`data-effects-wayfinder.ts`)
// and the purge's live-map path is `s0-5-effect-purge-path`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
import { WAYFINDER_EFFECTS } from '../../packages/core-wire/src/data-effects-wayfinder.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import type { Task } from '../acceptance/role-case-bodies.ts';
import { serverUrl } from '../acceptance/world.ts';
import { pathFaults } from './s0-5-effect-diff.ts';

/** The ordinary task commands that write a ticket's row or a link to it. */
const ON_A_TICKET: readonly CommandName[] = [
  'task.create',
  'task.update',
  'task.complete',
  'task.reopen',
  'task.comment',
  'task.edit_comment',
  'task.delete_comment',
  'task.start',
  'task.assign',
  'task.triage',
  'task.set_stage',
  'task.set_state',
  'task.set_scores',
  'task.set_adhoc',
  'task.set_category',
  'task.duplicate',
  'task.set_party',
  'task.restore',
  'task.set_audience',
  'task.reparent',
  'task.move',
  'task.rank',
  'task.trash',
];

const MAP_READ_MODEL = ['map_summaries', 'map_frontier'];

let harness: Harness;
let liveMap: string | undefined;

/** A fresh open, unassigned ticket under the one live map every path shares. */
async function freshTicket(title: string): Promise<Task> {
  liveMap ??= String(
    (await harness.asPerson('task.create', { fields: { title: 'a live map' }, taskType: 'map' }))
      .body['recordId'],
  );
  const made = await harness.asPerson('task.create', { fields: { title }, parentId: liveMap });
  if (made.code !== 'ok') throw new Error(`a ticket under the map refused ${made.code}`);
  return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
}

/** The command's positive recipe on tickets, as the act; a create files its own ticket. */
async function onATicket(name: CommandName): Promise<() => Promise<string>> {
  const declaration = COMMAND_SURFACE.find((one) => one.name === name);
  if (declaration === undefined) throw new Error(`${name} is not in the surface`);
  const prepared = await harness.positiveBodyOn(freshTicket)(declaration);
  if ('exception' in prepared) throw new Error(`${name}: no fixture (${prepared.exception})`);
  // An open ticket the act does not touch, so the map's frontier is never empty before or after.
  await freshTicket('a ticket the frontier keeps');
  const body = name === 'task.create' ? { ...prepared.body, parentId: liveMap } : prepared.body;
  return async () => (await harness.asPerson(name, body)).code;
}

describe.skipIf(serverUrl === undefined)('S0-5 effect metadata: a task command on a ticket', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_map');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each(ON_A_TICKET)(
    '%s on a ticket declares the map summary and frontier it refreshes',
    async (name) => {
      const path = { name, code: 'ok', drives: MAP_READ_MODEL, prepare: () => onATicket(name) };
      expect(await pathFaults(harness.world.db.admin, path)).toStrictEqual([]);
    },
    120_000,
  );

  it('every other command declaring the map read model is a map command or the purge', () => {
    const declaring = COMMAND_SURFACE.map(({ name }) => name).filter(
      (name) =>
        !(name in WAYFINDER_EFFECTS) &&
        name !== 'task.purge' &&
        COMMAND_EFFECTS[name].writes.some(({ kind }) => MAP_READ_MODEL.includes(kind)),
    );
    expect(declaring.toSorted()).toStrictEqual([...ON_A_TICKET].toSorted());
  });
});

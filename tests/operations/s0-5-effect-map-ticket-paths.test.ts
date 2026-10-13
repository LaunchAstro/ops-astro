// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on a path the positive fixtures miss: an
// ordinary task command on an open, unassigned ticket under a live map. Every
// write to a map's ticket refreshes the map's summary and frontier through the
// records trigger (`map_summary_on_record`), which rewrites `map_frontier` and
// upserts `map_summaries`, so each command that writes a task must declare
// those two read-model tables as well. The positive fixtures write ordinary
// tasks, so `s0-5-effect-metadata.test.ts` never reaches this; each command
// here runs alone on a fresh ticket and must write nothing undeclared.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { pathFaults } from './s0-5-effect-diff.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-effect-map-ticket-paths: DATABASE_URL is unset, so nothing ran.');
}

let harness: Harness;

/** A task the admin creates; its id. */
async function created(body: Readonly<Record<string, unknown>>): Promise<string> {
  const answer = await harness.asPerson('task.create', body);
  if (answer.code !== 'ok') throw new Error(`task.create refused ${answer.code}`);
  return String(answer.body['recordId']);
}

async function revisionOf(recordId: string): Promise<number> {
  const read = await harness.asPerson('task.read', { recordId });
  return (read.body['task'] as { readonly revision: number }).revision;
}

/** An open, unassigned ticket under a live map, beside a sibling; the ticket's id. */
async function ticketUnderLiveMap(): Promise<string> {
  const mapId = await created({ fields: { title: 'a live map' }, taskType: 'map' });
  await created({ fields: { title: 'a sibling ticket' }, parentId: mapId });
  return await created({ fields: { title: 'the ticket' }, parentId: mapId });
}

/** Each task command and what it sends to the ticket beside its revision. */
const ON_THE_TICKET: readonly (readonly [CommandName, () => Record<string, unknown>])[] = [
  ['task.update', () => ({ fields: { title: 'the ticket, renamed' } })],
  ['task.set_scores', () => ({ fields: { impact: 7 } })],
  ['task.complete', () => ({})],
  // An assigned ticket leaves the frontier.
  ['task.assign', () => ({ fields: { assignee: harness.world.mia.personId } })],
];

describe.skipIf(serverUrl === undefined)('S0-5 effect metadata: a ticket on a live map', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_map_ticket');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each(ON_THE_TICKET)(
    "%s on a map's ticket declares the map summary and frontier it refreshes",
    async (name, body) => {
      const faults = await pathFaults(harness.world.db.admin, {
        name,
        code: 'ok',
        drives: ['records', 'map_summaries', 'map_frontier'],
        prepare: async () => {
          const recordId = await ticketUnderLiveMap();
          const expectedRevision = await revisionOf(recordId);
          return async () =>
            (await harness.asPerson(name, { recordId, expectedRevision, ...body() })).code;
        },
      });
      expect(faults).toStrictEqual([]);
    },
    120_000,
  );
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// `map.chart` through the envelope: a ticket's `blockedBy` is a set, as
// `task.set_blocking` treats it, so a repeated ref charts one blocking edge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

let w: WayfinderWorld;
let owner: Decider;

const chart = async (tickets: readonly Record<string, unknown>[]) => {
  const answer = await w.as(owner, { command: 'map.chart', title: 'Chart', tickets });
  const filed = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets;
  return { code: codeOf(answer), tickets: filed ?? {} };
};

const blockersOf = async (id: string | undefined) =>
  (
    await w.db.admin.execute<{ readonly from_record_id: string }>(
      `select from_record_id from public.record_links
        where business_id = $1 and link_type = 'blocks' and to_record_id = $2`,
      [w.business, id],
    )
  ).map((row) => row.from_record_id);

describe.skipIf(databaseUrlFromEnvironment() === undefined)('map.chart refs', () => {
  beforeAll(async () => {
    w = await wayfinderWorld('chartrefs', 'chartrefs');
    owner = await w.decider('owner');
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('a blocker named twice in one ticket charts one blocking edge', async () => {
    const { code, tickets } = await chart([
      { ref: 'a', title: 'A', type: 'research' },
      { ref: 'b', title: 'B', type: 'task', blockedBy: ['a', 'a'] },
    ]);
    expect(code).toBe('applied');
    expect(await blockersOf(tickets['b'])).toStrictEqual([tickets['a']]);
  });
});

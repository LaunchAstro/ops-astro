// SPDX-License-Identifier: AGPL-3.0-only
//
// `map.chart` writes a map, its tickets and a blocking edge per blocker in one
// transaction, under one operation identity. Attacked through the envelope:
// the same chart sent again after its answer was lost replays the first map
// and charts nothing more; the same chart sent twice at once on two
// connections charts one map; and a chart whose transaction aborts before its
// write, or after its write and before the commit, leaves nothing, and sent
// again charts one map with each blocking edge once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

let w: WayfinderWorld;
let owner: Decider;

type Step = 'before-work' | 'before-commit';

/** The chart's request: a fresh title, two tickets, `b` blocked by `a`. */
const chartOf = (operationId: string) => ({
  command: 'map.chart',
  operationId,
  title: `Chart ${operationId}`,
  tickets: [
    { ref: 'a', title: 'A', type: 'research' },
    { ref: 'b', title: 'B', type: 'task', blockedBy: ['a'] },
  ],
});

/** Records titled as the chart's map, and blocking edges among that chart's tickets. */
const footprint = async (operationId: string) => {
  const maps = await w.db.admin.execute<{ readonly id: string }>(
    `select id from public.records where business_id = $1 and data->>'title' = $2`,
    [w.business, `Chart ${operationId}`],
  );
  const edges = await w.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.record_links l
       join public.records t on t.business_id = l.business_id and t.id = l.to_record_id
      where l.business_id = $1 and l.link_type = 'blocks' and t.data->>'parent' = any($2)`,
    [w.business, maps.map((map) => map.id)],
  );
  return { maps: maps.length, edges: Number(edges[0]?.n) };
};

/** The world's pool, except that its first transaction aborts at `step`. */
function abortingFirst(step: Step): Database {
  const inner = w.db.app;
  let transactions = 0;
  return {
    log: inner.log,
    close: async () => await inner.close(),
    withBusiness: async (business, work) =>
      await inner.withBusiness(business, async (tx) => {
        transactions += 1;
        if (transactions !== 1) return await work(tx);
        if (step === 'before-work') throw new Error('the chart died before its write');
        await work(tx);
        throw new Error('the chart died after its write, before the commit');
      }),
  };
}

const mapIdOf = (answer: unknown) => (answer as { recordId?: string }).recordId;

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a map chart raced, crashed or retried',
  () => {
    beforeAll(async () => {
      w = await wayfinderWorld('chartrace', 'chartrace');
      owner = await w.decider('owner');
    }, 180_000);

    afterAll(async () => await w?.drop());

    it('the same chart sent again after its answer was lost replays the first map and charts nothing more', async () => {
      const operationId = randomUUID();
      const first = await w.as(owner, chartOf(operationId));
      expect(codeOf(first)).toBe('applied');
      const again = await w.as(owner, chartOf(operationId));
      expect(again).toStrictEqual(first);
      expect(await footprint(operationId)).toStrictEqual({ maps: 1, edges: 1 });
    });

    it('the same chart sent twice at once on two connections charts one map', async () => {
      const operationId = randomUUID();
      const answers = await Promise.all([
        w.as(owner, chartOf(operationId)),
        w.asOnSecond(owner, chartOf(operationId)),
      ]);
      expect(answers.map((answer) => codeOf(answer))).toStrictEqual(['applied', 'applied']);
      expect(mapIdOf(answers[0])).toBe(mapIdOf(answers[1]));
      expect(await footprint(operationId)).toStrictEqual({ maps: 1, edges: 1 });
    });

    it.each([
      { step: 'before-work', when: 'before its write' },
      { step: 'before-commit', when: 'after its write, before the commit' },
    ] as const)(
      'a chart whose transaction aborts $when leaves nothing, and sent again charts one map',
      async ({ step }) => {
        const operationId = randomUUID();
        await expect(
          executeCommand(
            abortingFirst(step),
            w.business,
            owner.presented,
            'api',
            chartOf(operationId) as never,
          ),
        ).rejects.toThrow();
        expect(await footprint(operationId)).toStrictEqual({ maps: 0, edges: 0 });
        expect(codeOf(await w.as(owner, chartOf(operationId)))).toBe('applied');
        expect(await footprint(operationId)).toStrictEqual({ maps: 1, edges: 1 });
      },
    );
  },
);

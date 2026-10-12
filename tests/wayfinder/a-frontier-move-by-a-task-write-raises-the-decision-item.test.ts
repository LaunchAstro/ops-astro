// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-2's decision item through any write that moves a map's frontier: a
// grilling ticket reaches the frontier when its blocker is completed with
// `task.complete`, the generic completion, or trashed with `task.trash`, as
// well as through the wayfinder commands. Reaching it any way, the map's owner
// is owed one decision item, raised once per ticket however often the ticket
// leaves and reaches the frontier again, and only in the map's own business.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('WF-2 decision item, other writes', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  beforeAll(async () => {
    w = await wayfinderWorld('wf2o', 'wftwoother');
    owner = await w.decider('owner');
  }, 180_000);

  afterAll(async () => await w?.drop());

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  /** A map whose grilling ticket `g` waits on research ticket `a`. */
  async function charted(title: string): Promise<{ a: string; g: string }> {
    const answer = await w.as(owner, {
      command: 'map.chart',
      title,
      tickets: [
        { ref: 'a', title: 'research first', type: 'research' },
        { ref: 'g', title: 'then decide', type: 'grilling', blockedBy: ['a'] },
      ],
    });
    must(answer, 'map.chart');
    const tickets =
      (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets ?? {};
    return { a: tickets['a'] as string, g: tickets['g'] as string };
  }

  const onFrontier = async (ticket: string): Promise<boolean> =>
    (await w.db.admin.execute('select 1 from public.map_frontier where ticket_id = $1', [ticket]))
      .length === 1;

  /** Every decision item on `ticket`, in any business, with the business it sits in. */
  const decisions = async (ticket: string) =>
    (
      await w.db.admin.execute<{ business: string; recipient: string }>(
        `select business_id::text as business, recipient_person_id::text as recipient
           from public.inbox_items where reason = 'decision' and subject_record_id = $1`,
        [ticket],
      )
    ).map((item) => ({ business: item.business, recipient: item.recipient }));

  it('WF-2 decision item: a blocker completed by task.complete puts the grilling ticket on the frontier and raises its item', async () => {
    const { a, g } = await charted('complete map');
    expect(await decisions(g)).toStrictEqual([]);
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    expect(await onFrontier(g)).toBe(true);
    expect(await decisions(g)).toStrictEqual([{ business: w.business, recipient: owner.personId }]);
  });

  it('WF-2 decision item: a blocker trashed puts the grilling ticket on the frontier and raises its item', async () => {
    const { a, g } = await charted('trash map');
    must(await w.as(owner, { command: 'task.trash', ...(await at(a)) }), 'task.trash');
    expect(await onFrontier(g)).toBe(true);
    expect(await decisions(g)).toStrictEqual([{ business: w.business, recipient: owner.personId }]);
  });

  it('WF-2 decision item: raised once per ticket, though it leaves the frontier and comes back', async () => {
    const { a, g } = await charted('again map');
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    must(
      await w.as(owner, { command: 'task.reopen', reason: 'More to read', ...(await at(a)) }),
      'task.reopen',
    );
    expect(await onFrontier(g)).toBe(false);
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    expect(await onFrontier(g)).toBe(true);
    expect(await decisions(g)).toHaveLength(1);
  });

  it('WF-2 decision item: written only in the map business, the other business sees none', async () => {
    const { a, g } = await charted('own business map');
    must(await w.as(owner, { command: 'task.complete', ...(await at(a)) }), 'task.complete');
    const [bravoItems] = await w.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from public.inbox_items where business_id = $1',
      [w.bravo],
    );
    expect(bravoItems?.n).toBe('0');
    expect((await decisions(g)).map((item) => item.business)).toStrictEqual([w.business]);
  });
});

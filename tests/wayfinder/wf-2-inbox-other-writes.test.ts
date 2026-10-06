// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite on one shared world */
//
// #673: a grilling or prototype ticket that reaches its map's frontier owes the
// map's owner one decision item, whichever write moved it there. Before the
// fix only the four wayfinder commands raised it, so a blocker completed by
// someone else, or an assignee cleared, left the owner with nothing to decide.
// The item is raised at commit for the frontier the transaction leaves, so a
// ticket that crosses the frontier and leaves it again in one transaction owes
// nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { must, wayfinderWorld, type Member, type WayfinderWorld } from './world.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

interface Item {
  readonly business: string;
  readonly recipient: string;
  readonly state: string;
}

describe.skipIf(serverUrl === undefined)('WF-2 decision items from every frontier write', () => {
  let w: WayfinderWorld;
  let bea: Member;
  let ada: Member;
  let clearer: Member;
  let beaB: Member;
  let adaB: Member;

  const at = async (id: string, business?: BusinessId) => ({
    recordId: id,
    expectedRevision: await w.revisionOf(id, business),
  });

  const chart = async (
    who: Member,
    tickets: readonly Record<string, unknown>[],
    business: BusinessId = w.business,
  ) => {
    const answer = await w.as(
      who,
      { command: 'map.chart', title: 'a decision map', tickets },
      business,
    );
    const made = must(answer, 'map.chart');
    const ids = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets;
    return { map: made.id, t: ids ?? {} };
  };

  const complete = async (who: Member, id: string, business: BusinessId = w.business) =>
    must(
      await w.as(who, { command: 'task.complete', ...(await at(id, business)) }, business),
      'complete',
    );

  const assign = async (who: Member, id: string, assignee: string | null) =>
    must(
      await w.as(who, { command: 'task.assign', ...(await at(id)), fields: { assignee } }),
      'assign',
    );

  const retitle = async (who: Member, id: string) =>
    must(
      await w.as(who, { command: 'task.update', ...(await at(id)), fields: { title: 'retitled' } }),
      'update',
    );

  /** Every decision item about one ticket, in any business and any work state. */
  const items = async (ticket: string): Promise<readonly Item[]> =>
    (
      await w.db.admin.execute<Item>(
        `select business_id::text as business, recipient_person_id::text as recipient,
                work_state as state
           from public.inbox_items
          where subject_record_id = $1 and fact_id = $1 and fact_kind = 'record'
            and reason = 'decision'
          order by raised_at`,
        [ticket],
      )
    ).map(({ business, recipient, state }) => ({ business, recipient, state }));

  const onFrontier = async (map: string, business: BusinessId = w.business) =>
    (
      await w.db.admin.execute<{ readonly ticket_id: string }>(
        `select ticket_id::text as ticket_id from public.map_frontier
          where business_id = $1 and map_id = $2 order by position`,
        [business, map],
      )
    ).map((row) => row.ticket_id);

  beforeAll(async () => {
    w = await wayfinderWorld('wf2io', 'wftwoio');
    bea = await w.decider('bea');
    await w.grant(bea, 'assign');
    ada = await w.member('ada', ['read', 'write']);
    clearer = await w.member('clearer', ['read', 'assign']);
    beaB = await w.outsider('bea-bravo');
    adaB = await w.outsider('ada-bravo');
    await w.db.app.withBusiness(w.bravo, async (tx) => {
      await grantTo(tx, beaB, 'decide');
    });
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('raises nothing for a ticket the chart blocks, then once when someone else completes its blocker', async () => {
    const { map, t } = await chart(bea, [
      { ref: 'a', title: 'find the rules', type: 'research' },
      { ref: 'g', title: 'choose the flow', type: 'grilling', blockedBy: ['a'] },
    ]);
    const g = t['g'] as string;
    expect(await onFrontier(map)).toStrictEqual([t['a']]);
    expect(await items(g)).toStrictEqual([]);

    await complete(ada, t['a'] as string);
    expect(await onFrontier(map)).toStrictEqual([g]);
    expect(await items(g)).toStrictEqual([
      { business: w.business, recipient: bea.personId, state: 'open' },
    ]);
    expect(await items(t['a'] as string)).toStrictEqual([]);

    // A second write that leaves g on the frontier raises nothing more.
    await retitle(ada, g);
    expect(await items(g)).toHaveLength(1);

    // Cleared, it is not raised again by a later frontier write.
    await w.db.admin.execute(
      `update public.inbox_items
          set work_state = 'cleared', closed_at = now(), closed_by_person_id = recipient_person_id
        where subject_record_id = $1 and reason = 'decision'`,
      [g],
    );
    await retitle(ada, g);
    expect(await items(g)).toStrictEqual([
      { business: w.business, recipient: bea.personId, state: 'cleared' },
    ]);
  });

  it('raises once for a prototype ticket freed by clearing its assignee', async () => {
    const { map, t } = await chart(bea, [
      { ref: 'b', title: 'look first', type: 'research' },
      { ref: 'p', title: 'try the menu', type: 'prototype', blockedBy: ['b'] },
    ]);
    const p = t['p'] as string;
    await assign(bea, p, ada.personId);
    await complete(ada, t['b'] as string);
    expect(await onFrontier(map)).toStrictEqual([]);
    expect(await items(p)).toStrictEqual([]);

    await assign(clearer, p, null);
    expect(await onFrontier(map)).toStrictEqual([p]);
    expect(await items(p)).toStrictEqual([
      { business: w.business, recipient: bea.personId, state: 'open' },
    ]);
  });

  it('raises nothing when one transaction moves a ticket onto the frontier and off again', async () => {
    const { map, t } = await chart(bea, [
      { ref: 'b', title: 'look first', type: 'research' },
      { ref: 'p', title: 'held prototype', type: 'prototype', blockedBy: ['b'] },
    ]);
    const p = t['p'] as string;
    await assign(bea, p, ada.personId);
    await complete(ada, t['b'] as string);
    const midway = await w.db.app.withBusiness(w.business, async (tx) => {
      await tx.query(
        `update records set data = data - 'assignee' where business_id = $1 and id = $2`,
        [w.business, p],
      );
      const seen = await tx.query<{ readonly n: number }>(
        `select count(*)::int as n from map_frontier where business_id = $1 and ticket_id = $2`,
        [w.business, p],
      );
      await tx.query(
        `update records set data = data || jsonb_build_object('assignee', $3::text)
          where business_id = $1 and id = $2`,
        [w.business, p, ada.personId],
      );
      return seen[0]?.n;
    });
    expect(midway).toBe(1);
    expect(await onFrontier(map)).toStrictEqual([]);
    expect(await items(p)).toStrictEqual([]);
  });

  it('raises nothing for research or task tickets reaching the frontier', async () => {
    const { map, t } = await chart(bea, [
      { ref: 'x', title: 'first', type: 'research' },
      { ref: 'y', title: 'second', type: 'research', blockedBy: ['x'] },
      { ref: 'z', title: 'third', type: 'task', blockedBy: ['x'] },
    ]);
    await complete(ada, t['x'] as string);
    expect(await onFrontier(map)).toStrictEqual([t['y'], t['z']]);
    for (const ticket of ['x', 'y', 'z'])
      expect(await items(t[ticket] as string)).toStrictEqual([]);
  });

  it.each([
    ['no owner', null],
    ['an owner that is not a uuid', 'not-a-uuid'],
  ])('raises nothing on a map with %s', async (_, owner) => {
    const { map, t } = await chart(bea, [
      { ref: 'a', title: 'find out', type: 'research' },
      { ref: 'g', title: 'decide', type: 'grilling', blockedBy: ['a'] },
    ]);
    await w.db.admin.execute(
      `update public.records
          set data = case when $2::text is null then data - 'map_owner'
                          else data || jsonb_build_object('map_owner', $2::text) end
        where business_id = $1 and id = $3`,
      [w.business, owner, map],
    );
    await complete(ada, t['a'] as string);
    expect(await onFrontier(map)).toStrictEqual([t['g']]);
    expect(await items(t['g'] as string)).toStrictEqual([]);
  });

  it('WF-2 isolation: each business raises its own owner only, and an owner of another business none', async () => {
    const alpha = await chart(bea, [
      { ref: 'a', title: 'alpha research', type: 'research' },
      { ref: 'g', title: 'alpha grilling', type: 'grilling', blockedBy: ['a'] },
    ]);
    const bravo = await chart(
      beaB,
      [
        { ref: 'a', title: 'bravo research', type: 'research' },
        { ref: 'g', title: 'bravo grilling', type: 'grilling', blockedBy: ['a'] },
      ],
      w.bravo,
    );
    // A third map, in bravo, whose owner names alpha's Bea.
    const crossed = await chart(
      beaB,
      [
        { ref: 'a', title: 'crossed research', type: 'research' },
        { ref: 'g', title: 'crossed grilling', type: 'grilling', blockedBy: ['a'] },
      ],
      w.bravo,
    );
    await w.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('map_owner', $3::text)
        where business_id = $1 and id = $2`,
      [w.bravo, crossed.map, bea.personId],
    );
    await complete(ada, alpha.t['a'] as string);
    await complete(adaB, bravo.t['a'] as string, w.bravo);
    await complete(adaB, crossed.t['a'] as string, w.bravo);

    const alphaG = alpha.t['g'] as string;
    const bravoG = bravo.t['g'] as string;
    expect(await items(alphaG)).toStrictEqual([
      { business: w.business, recipient: bea.personId, state: 'open' },
    ]);
    expect(await items(bravoG)).toStrictEqual([
      { business: w.bravo, recipient: beaB.personId, state: 'open' },
    ]);
    expect(await onFrontier(crossed.map, w.bravo)).toStrictEqual([crossed.t['g']]);
    expect(await items(crossed.t['g'] as string)).toStrictEqual([]);

    // Each business's own reads see its own item and never the other's.
    const seen = async (business: BusinessId) =>
      await w.db.app.withBusiness(business, async (tx) =>
        (
          await tx.query<{ readonly subject: string }>(
            `select subject_record_id::text as subject from inbox_items
              where reason = 'decision' and subject_record_id = any($1::uuid[])`,
            [[alphaG, bravoG]],
          )
        ).map((row) => row.subject),
      );
    expect(await seen(w.business)).toStrictEqual([alphaG]);
    expect(await seen(w.bravo)).toStrictEqual([bravoG]);
  });
});

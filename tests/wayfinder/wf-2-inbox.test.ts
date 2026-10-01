// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the decision item's cases on one world */
//
// WF-2's decision item: a grilling or prototype ticket reaching the frontier
// raises one decision item in the map owner's inbox (MP-7-3), in the
// transaction of the write that put it there (`wayfinder-frontier-raise.ts`).
// Charted with no blocker is reaching it too. It is raised once per ticket
// and owner: a later write, or the owner clearing it, raises no second one.
// Research, task and build tickets reaching the frontier raise nothing, and
// nobody but the map's owner is raised one: not a teammate holding decide on
// the map, not another map's owner, not another business.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Item {
  readonly business: string;
  readonly recipient: string;
  readonly subject: string;
  readonly state: string;
}

describe.skipIf(serverUrl === undefined)('WF-2 decision item', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const charted = async (who: Decider, body: Record<string, unknown>) => {
    const answer = await w.as(who, { command: 'map.chart', ...body });
    const made = must(answer, 'map.chart');
    return {
      map: made.id,
      tickets: (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets ?? {},
    };
  };
  const resolve = async (who: Decider, id: string) =>
    must(
      await w.as(who, {
        command: 'task.resolve',
        ...(await at(id)),
        answer: 'the answer',
        gist: 'a gist',
      }),
      'task.resolve',
    );
  /** Every decision item about these subjects, in every business. */
  const decisions = async (...subjects: string[]): Promise<readonly Item[]> =>
    await w.db.admin.execute<Item>(
      `select business_id::text as business, recipient_person_id::text as recipient,
              subject_record_id::text as subject, work_state as state
         from public.inbox_items
        where reason = 'decision' and subject_record_id = any($1::uuid[])
        order by raised_at, subject_record_id::text`,
      [subjects],
    );

  beforeAll(async () => {
    w = await wayfinderWorld('wf2i', 'wftwoinbox');
    owner = await w.decider('owner');
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('WF-2 a grilling or prototype ticket reaching the frontier raises one decision item for the map owner', async () => {
    const { tickets } = await charted(owner, {
      title: 'inbox map',
      tickets: [
        { ref: 'a', title: 'research first', type: 'research' },
        { ref: 'g', title: 'then decide', type: 'grilling', blockedBy: ['a'] },
        { ref: 'p', title: 'then try it', type: 'prototype', blockedBy: ['a'] },
      ],
    });
    const a = tickets['a'] as string;
    const g = tickets['g'] as string;
    const p = tickets['p'] as string;
    expect(await decisions(a, g, p)).toHaveLength(0);
    await resolve(owner, a);
    const items = await decisions(a, g, p);
    expect(items.map((i) => [i.subject, i.recipient, i.business])).toStrictEqual(
      [g, p].toSorted().map((subject) => [subject, owner.personId, w.business]),
    );
  });

  it('WF-2 decision item: a grilling ticket charted with no blocker is raised at the chart, once', async () => {
    const { tickets } = await charted(owner, {
      title: 'open map',
      tickets: [
        { ref: 'g', title: 'decide now', type: 'grilling' },
        { ref: 'r', title: 'look around', type: 'research' },
        { ref: 'b', title: 'build it', type: 'build' },
      ],
    });
    const g = tickets['g'] as string;
    const r = tickets['r'] as string;
    const b = tickets['b'] as string;
    expect((await decisions(g, r, b)).map((i) => i.subject)).toStrictEqual([g]);
    // A later write that leaves it on the frontier raises no second item.
    await resolve(owner, r);
    expect(await decisions(g, r, b)).toHaveLength(1);
  });

  it('WF-2 decision item: one the owner cleared is not raised again by a later write', async () => {
    const { tickets } = await charted(owner, {
      title: 'cleared map',
      tickets: [
        { ref: 'g', title: 'decide once', type: 'grilling' },
        { ref: 'r', title: 'later research', type: 'research' },
      ],
    });
    const g = tickets['g'] as string;
    const r = tickets['r'] as string;
    await w.db.admin.execute(
      `update public.inbox_items
          set work_state = 'cleared', closed_at = now(), closed_by_person_id = recipient_person_id
        where reason = 'decision' and subject_record_id = $1`,
      [g],
    );
    await resolve(owner, r);
    expect((await decisions(g)).map((i) => i.state)).toStrictEqual(['cleared']);
  });

  it('WF-2 decision item isolation: only the map owner, of this map, in this business', async () => {
    // Person to person: a teammate holding decide on the map is raised nothing.
    const teammate = await w.decider('teammate');
    const mine = await charted(owner, {
      title: 'owner map',
      tickets: [
        { ref: 'a', title: 'research', type: 'research' },
        { ref: 'g', title: 'decide', type: 'grilling', blockedBy: ['a'] },
      ],
    });
    // Map to map: the teammate's own map, with a grilling ticket waiting on research.
    const theirs = await charted(teammate, {
      title: 'teammate map',
      tickets: [
        { ref: 'a', title: 'their research', type: 'research' },
        { ref: 'g', title: 'their decision', type: 'grilling', blockedBy: ['a'] },
      ],
    });
    await resolve(owner, mine.tickets['a'] as string);
    const mineG = mine.tickets['g'] as string;
    const theirsG = theirs.tickets['g'] as string;
    expect((await decisions(mineG, theirsG)).map((i) => [i.subject, i.recipient])).toStrictEqual([
      [mineG, owner.personId],
    ]);

    // Business to business: a map in bravo raises its owner's item there, and
    // nothing in this business, nor for anyone here.
    const bea = await w.outsider('bea');
    await w.db.app.withBusiness(w.bravo, async (tx) => {
      await grantTo(tx, bea, 'decide');
    });
    const bravo = must(
      await w.as(
        bea,
        {
          command: 'map.chart',
          title: 'bravo map',
          tickets: [{ ref: 'g', title: 'x', type: 'grilling' }],
        },
        w.bravo,
      ),
      'bravo map.chart',
    );
    expect(bravo.id).toBeTruthy();
    const bravoItems = await w.db.admin.execute<Item>(
      `select business_id::text as business, recipient_person_id::text as recipient,
              subject_record_id::text as subject, work_state as state
         from public.inbox_items where reason = 'decision' and business_id = $1`,
      [w.bravo],
    );
    expect(bravoItems.map((i) => i.recipient)).toStrictEqual([bea.personId]);
    expect(bravoItems.map((i) => i.subject)).not.toContain(mineG);
    const here = await w.db.admin.execute<{ readonly subject: string }>(
      `select subject_record_id::text as subject from public.inbox_items
        where reason = 'decision' and business_id = $1`,
      [w.business],
    );
    for (const item of bravoItems) expect(here.map((h) => h.subject)).not.toContain(item.subject);
  });
});

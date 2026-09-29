// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one held case on its own world */
//
// WF-2's decision item: a grilling or prototype ticket reaching the frontier
// raises one decision item in the map owner's inbox (MP-7-3). Held: the inbox
// (`inbox_items`, `raiseDecision`) lands with SL04 U99, so this case is skipped
// until the rebase onto batch 1, and the file is listed as deliberately
// unnamed in the database manifest, which refuses a skipped test in a named
// suite. At the rebase: drop the skip, name this file, build the raise.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('WF-2 decision item (held)', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const charted = async (body: Record<string, unknown>) => {
    const answer = await w.as(owner, { command: 'map.chart', ...body });
    must(answer, 'map.chart');
    return {
      tickets: (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets ?? {},
    };
  };
  const resolve = async (_who: Decider, id: string) =>
    await w.as(owner, {
      command: 'task.resolve',
      ...(await at(id)),
      answer: 'the answer',
      gist: 'a gist',
    });

  beforeAll(async () => {
    w = await wayfinderWorld('wf2i', 'wftwoinbox');
    owner = await w.decider('owner');
  }, 180_000);

  afterAll(async () => await w?.drop());

  it.skip('WF-2 a grilling or prototype ticket reaching the frontier raises one decision item for the map owner', async () => {
    const { tickets } = await charted({
      title: 'inbox map',
      tickets: [
        { ref: 'a', title: 'research first', type: 'research' },
        { ref: 'g', title: 'then decide', type: 'grilling', blockedBy: ['a'] },
      ],
    });
    must(await resolve(owner, tickets['a'] as string), 'resolve');
    const items = await w.db.admin.execute<{ readonly recipient_person_id: string }>(
      `select recipient_person_id from public.inbox_items
        where business_id = $1 and subject_record_id = $2 and reason = 'decision'`,
      [w.business, tickets['g']],
    );
    expect(items.map((i) => i.recipient_person_id)).toStrictEqual([owner.personId]);
  });
});

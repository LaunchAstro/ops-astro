// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-4 isolation` (#637): the three real crossings for the tickets,
// frontier and fog views and their two writes, statuses checked, canaries
// absent from every page and answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { chart, openMap, scopedMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (answer: unknown): string => (answer as { code?: string }).code ?? 'applied';

describe.skipIf(serverUrl === undefined)('WF-4 isolation', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf4iso', 'wffouriso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide', 'share']);
  }, 180_000);

  // Each case's pages go with it, so no two pages share the document; one at
  // a time, since overlapping act() calls leave the next render unflushed.
  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  it('WF-4 isolation', async () => {
    // Map A for client X, map B for client Y, each scoped while empty.
    const a = await scopedMap(w, lead, 'canary-wf4-A', 'canary-wf4-A ticket');
    const b = await scopedMap(w, lead, 'canary-wf4-B', 'canary-wf4-B ticket', ['canary-wf4-B fog']);
    const bTicket = b.tickets['t'] as string;
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf4-B', b.map, bTicket])
        expect(text, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person reaches none of alpha's views, and
    // cannot name alpha's ticket as a blocker of its own.
    const bea = await w.outsider('wf4-bea');
    const bravoPage = await openMap(w, open, bea, b.key, `${w.key}-bravo`);
    expect(bravoPage.find('[data-map-refused]')?.textContent).toContain('NOT_FOUND');
    expect(bravoPage.find('[role="tab"]')).toBeNull();
    clean('bravo page', bravoPage.text());
    const own = await w.as(
      bea,
      {
        command: 'map.chart',
        title: 'bravo map',
        destination: 'bravo',
        tickets: [{ ref: 'x', title: 'bravo x', type: 'task' }],
        fog: [],
      },
      w.bravo,
    );
    const bravoTicket = (own as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets?.['x'] as string;
    const crossed = await w.as(
      bea,
      {
        command: 'task.set_blocking',
        recordId: bravoTicket,
        expectedRevision: await w.revisionOf(bravoTicket, w.bravo),
        blockedBy: [bTicket],
      },
      w.bravo,
    );
    expect(codeOf(crossed)).toBe('NOT_FOUND');
    clean('bravo blocking', JSON.stringify(crossed));

    // 2. Another client in the same business: a person granted only map A
    // reads map A and its frontier, and none of client Y's map B.
    const scoped = await w.member('wf4-scoped-a', ['read', 'write'], { kind: 'record', id: a.map });
    const readsA = await openMap(w, open, scoped, a.key);
    expect(readsA.find('[role="tab"]')).not.toBeNull();
    expect(codeOf(await w.read(scoped, { read: 'map.frontier', recordId: a.map }))).toBe('applied');
    const other = await openMap(w, open, scoped, b.key);
    expect(other.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(other.find('[role="tab"]')).toBeNull();
    clean('other client page', other.text());
    const frontierB = await w.read(scoped, { read: 'map.frontier', recordId: b.map });
    expect(codeOf(frontierB)).toBe('SCOPE_NOT_GRANTED');
    clean('other client frontier', JSON.stringify(frontierB));
    const patch = (
      (await w.read(lead, { read: 'map.view', recordId: b.map })) as {
        map: { fog: { id: string }[] };
      }
    ).map.fog[0]?.id;
    const graduate = await w.as(scoped, {
      command: 'map.graduate',
      ...(await at(b.map)),
      patchId: patch,
      tickets: [{ title: 'x', type: 'task' }],
    });
    expect(codeOf(graduate)).toBe('SCOPE_NOT_GRANTED');
    const blockAcross = await w.as(scoped, {
      command: 'task.set_blocking',
      ...(await at(a.tickets['t'] as string)),
      blockedBy: [bTicket],
    });
    expect(['NOT_FOUND', 'SCOPE_NOT_GRANTED']).toContain(codeOf(blockAcross));
    clean('other client writes', JSON.stringify([graduate, blockAcross]));

    // 3. A person under a live delegation: the agent comments on its own task,
    // is refused map B's ticket as outside its purpose, and reaches no frontier
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('wf4-delegator'), 'frontier agent task');
    const agent = await w.agent(picked.credential);
    const revision = String(await w.revisionOf(picked.taskId));
    const mine = await agent.run(
      'task',
      'comment',
      picked.taskId,
      '--revision',
      revision,
      '--text',
      'on it',
    );
    expect(mine.exit, mine.out).toBe(0);
    for (const [code, argv] of [
      ['DELEGATION_OUT_OF_PURPOSE', ['task', 'comment', bTicket, '--revision', '1', '--text', 'x']],
      ['DELEGATION_EXCLUDES_OPERATION', ['map', 'frontier', b.map]],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const delegated = await agent.run(...argv);
      expect(delegated.exit, delegated.out).toBe(1);
      expect(delegated.out).toContain(code);
      clean('delegated', delegated.out);
    }
  });

  it('WF-4 a blocks link from a record that is not a ticket of the map is never shown', async () => {
    const m = await chart(w, lead, 'foreign-link', [
      { ref: 'a', title: 'foreign-link a', type: 'task' },
    ]);
    const other = await chart(w, lead, 'other-map', [{ ref: 'o', title: 'other o', type: 'task' }]);
    const a = m.tickets['a'] as string;
    // The ticket's own state record and another map's ticket, linked as
    // blockers behind the commands' back.
    const [row] = await w.db.admin.execute<{ readonly state: string }>(
      `select uuid_1::text as state from public.records where business_id = $1 and id = $2`,
      [w.business, a],
    );
    for (const from of [row?.state as string, other.tickets['o'] as string]) {
      // oxlint-disable-next-line no-await-in-loop
      await w.db.admin.execute(
        `insert into public.record_links (business_id, id, link_type, from_record_id, to_record_id)
         values ($1, $2, 'blocks', $3, $4)`,
        [w.business, crypto.randomUUID(), from, a],
      );
    }
    const viewed = (await w.read(lead, { read: 'map.view', recordId: m.map })) as {
      map: { tickets: readonly { id: string; blockedBy: readonly string[] }[] };
    };
    expect(viewed.map.tickets.find((t) => t.id === a)?.blockedBy).toStrictEqual([]);
    const page = await openMap(w, open, lead, m.key);
    await page.click('[role="tab"][id="map-tab-tickets"]');
    expect(page.find(`[data-ticket-row="${a}"] [data-blocked-by]`)).toBeNull();
  });
});

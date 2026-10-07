// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-4 isolation` (#637): the real crossings for the tickets, frontier and
// fog views and their two writes (another business, another client, a live
// delegation, and person to person inside one client, with a change of reader
// through the screen registry), statuses checked, canaries absent from every
// page and answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { chart, keyOf, openMap, openRegisteredMap, scopedMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (answer: unknown): string => (answer as { code?: string }).code ?? 'applied';

/** What a page shows a person: its text and every value typed into its fields. */
const shown = (page: Mounted): string =>
  [page.text(), ...page.all('input, textarea').map((f) => (f as HTMLInputElement).value)].join(
    '\n',
  );

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

  it('WF-4 isolation: another business, another client and a live delegation each reach none of the views or their writes', async () => {
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

  it("WF-4 person to person: in one business and one client, the person granted a map reads its views and writes them, the person granted only the client's other map reads and writes none of it, and a change of reader shows nobody the previous reader's unsaved graduation", async () => {
    // Map A and map C under the same client X: P holds map A, Q holds map C.
    const a = await scopedMap(w, lead, 'canary-wf4-P', 'canary-wf4-P ticket', [
      'canary-wf4-P fog one',
      'canary-wf4-P fog two',
    ]);
    const first = a.tickets['t'] as string;
    const second = (
      await w.create(lead, { title: 'canary-wf4-P second' }, { taskType: 'task', parentId: a.map })
    ).id;
    const viewed = (await w.read(lead, { read: 'map.view', recordId: a.map })) as {
      map: { client: string | null; fog: { id: string }[] };
    };
    const clientX = viewed.map.client as string;
    expect(clientX).toMatch(/^[0-9a-f-]{36}$/u);
    const [patchOne, patchTwo] = viewed.map.fog.map((f) => f.id);
    const c = (await w.create(lead, { title: 'wf4 map of Q' }, { taskType: 'map' })).id;
    expect(
      codeOf(await w.as(lead, { command: 'map.scope', ...(await at(c)), client: clientX })),
    ).toBe('applied');
    const p = await w.member('wf4-person-p', ['read', 'write'], { kind: 'record', id: a.map });
    const q = await w.member('wf4-person-q', ['read', 'write'], { kind: 'record', id: c });
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf4-P', a.map, first, second])
        expect(text, what).not.toContain(canary);
    };

    // The positive controls: P reads map A's views and makes both writes; Q reads map C.
    const readsA = await openMap(w, open, p, a.key);
    expect(readsA.find('[role="tab"]')).not.toBeNull();
    expect(codeOf(await w.read(p, { read: 'map.frontier', recordId: a.map }))).toBe('applied');
    const graduated = await w.as(p, {
      command: 'map.graduate',
      ...(await at(a.map)),
      patchId: patchTwo,
      tickets: [{ title: 'by P', type: 'task' }],
    });
    expect(codeOf(graduated)).toBe('applied');
    const blocked = await w.as(p, {
      command: 'task.set_blocking',
      ...(await at(second)),
      blockedBy: [first],
    });
    expect(codeOf(blocked)).toBe('applied');
    const readsC = await openMap(w, open, q, await keyOf(w, c));
    expect(readsC.find('[role="tab"]')).not.toBeNull();

    // The crossing: Q, in the same business and client, reads and writes none of map A.
    const crossed = await openMap(w, open, q, a.key);
    expect(crossed.find('[role="tab"]')).toBeNull();
    expect(crossed.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    clean('Q on map A', crossed.text());
    const frontier = await w.read(q, { read: 'map.frontier', recordId: a.map });
    expect(codeOf(frontier)).toBe('SCOPE_NOT_GRANTED');
    const version = await w.revisionOf(a.map);
    const graduate = await w.as(q, {
      command: 'map.graduate',
      ...(await at(a.map)),
      patchId: patchOne,
      tickets: [{ title: 'crossed', type: 'task' }],
    });
    expect(codeOf(graduate)).toBe('SCOPE_NOT_GRANTED');
    const unblock = await w.as(q, {
      command: 'task.set_blocking',
      ...(await at(second)),
      blockedBy: [],
    });
    expect(codeOf(unblock)).toBe('SCOPE_NOT_GRANTED');
    clean('Q reading and writing map A', JSON.stringify([frontier, graduate, unblock]));
    expect(await w.revisionOf(a.map)).toBe(version);
    expect(codeOf(await w.read(p, { read: 'map.frontier', recordId: a.map }))).toBe('applied');

    // A change of reader through the screen registry: P's unsaved graduation
    // of patch one is shown to neither Q nor the next person who holds map A.
    const draft = 'wf4-unsaved-draft-of-p';
    const registered = await openRegisteredMap(w, open, p, a.key);
    await registered.page.click('[role="tab"][id="map-tab-fog"]');
    await registered.page.click(`button[data-graduate="${String(patchOne)}"]`);
    await registered.page.type('input[name="ticket-title-0"]', draft);
    expect(shown(registered.page)).toContain(draft);
    await registered.switchTo(q);
    expect(registered.page.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(shown(registered.page)).not.toContain(draft);
    clean('Q after the switch', shown(registered.page));
    const next = await w.member('wf4-person-p2', ['read', 'write'], { kind: 'record', id: a.map });
    await registered.switchTo(next);
    expect(registered.page.find('[role="tab"]')).not.toBeNull();
    await registered.page.click('[role="tab"][id="map-tab-fog"]');
    expect(registered.page.find('input[name="ticket-title-0"]')).toBeNull();
    expect(shown(registered.page)).not.toContain(draft);
    expect(registered.page.find(`button[data-graduate="${String(patchOne)}"]`)).not.toBeNull();
  });
});

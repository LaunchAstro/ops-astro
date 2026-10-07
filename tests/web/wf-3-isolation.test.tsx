// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-3 isolation` (#636): the map view's real crossings, another business,
// another client, a live delegation, and person to person inside one client
// (with a change of reader through the screen registry), with the refusal
// codes checked and the canaries absent from every page and answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { keyOf, openMap, openRegisteredMap, scopedMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** What a page shows a person: its text and every value typed into its fields. */
const shown = (page: Mounted): string =>
  [page.text(), ...page.all('input, textarea').map((f) => (f as HTMLInputElement).value)].join(
    '\n',
  );

describe.skipIf(serverUrl === undefined)('WF-3 isolation', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf3iso', 'wfthreeiso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide', 'share']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const openMapAs = async (member: Member, mapKey: string, businessKey = w.key) =>
    await openMap(w, open, member, mapKey, businessKey);

  it('WF-3 isolation: another business, another client and a live delegation each reach none of the map', async () => {
    // Map A for client X, map B for client Y, each scoped while empty.
    const a = await scopedMap(w, lead, 'canary-wf3-A', 'canary-wf3-A ticket');
    const b = await scopedMap(w, lead, 'canary-wf3-B', 'canary-wf3-B ticket');
    const [mapB, keyB, ticketB] = [b.map, b.key, b.tickets['t'] as string];
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf3-B', mapB, ticketB])
        expect(text, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person asks for alpha's map by key.
    const bea = await openMapAs(await w.outsider('wf3-bea'), keyB, `${w.key}-bravo`);
    expect(bea.find('[data-map-refused]')?.textContent).toContain('NOT_FOUND');
    expect(bea.find('[data-map-section]')).toBeNull();
    clean('bravo', bea.text());

    // 2. Another client in the same business: a person granted only map A
    // reads map A, and none of client Y's map B.
    const scoped = await w.member('wf3-scoped-a', ['read', 'write'], { kind: 'record', id: a.map });
    const readsA = await openMapAs(scoped, a.key);
    expect(readsA.find('[data-map-section="destination"]')?.textContent).toContain('canary-wf3-A');
    const other = await openMapAs(scoped, keyB);
    expect(other.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(other.find('[data-map-section]')).toBeNull();
    clean('other client', other.text());
    const version = await w.revisionOf(mapB);
    const edit = await w.as(scoped, {
      command: 'map.revise',
      ...(await at(mapB)),
      notes: 'crossed',
    });
    expect((edit as { code?: string }).code).toBe('SCOPE_NOT_GRANTED');
    expect(await w.revisionOf(mapB)).toBe(version);

    // 3. A person under a live delegation: the agent comments on its own task,
    // is refused map B's ticket as outside its purpose, and reaches no map view
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('wf3-delegator'), 'map view agent task');
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
      ['DELEGATION_OUT_OF_PURPOSE', ['task', 'comment', ticketB, '--revision', '1', '--text', 'x']],
      ['DELEGATION_EXCLUDES_OPERATION', ['map', 'view', mapB]],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const delegated = await agent.run(...argv);
      expect(delegated.exit, delegated.out).toBe(1);
      expect(delegated.out).toContain(code);
      clean('delegated', delegated.out);
    }
  });

  it("WF-3 person to person: in one business and one client, the person granted a map reads and revises it, the person granted only the client's other map reads none of it, and a change of reader shows nobody the previous reader's unsaved draft", async () => {
    // Map A and map C under the same client X: P holds map A, Q holds map C.
    const a = await scopedMap(w, lead, 'canary-wf3-P', 'canary-wf3-P ticket');
    const ticketA = a.tickets['t'] as string;
    const viewed = (await w.read(lead, { read: 'map.view', recordId: a.map })) as {
      map: { client: string | null };
    };
    const clientX = viewed.map.client as string;
    expect(clientX).toMatch(/^[0-9a-f-]{36}$/u);
    const c = (await w.create(lead, { title: 'wf3 map of Q' }, { taskType: 'map' })).id;
    const scope = await w.as(lead, { command: 'map.scope', ...(await at(c)), client: clientX });
    expect((scope as { code?: string }).code).toBeUndefined();
    const p = await w.member('wf3-person-p', ['read', 'write'], { kind: 'record', id: a.map });
    const q = await w.member('wf3-person-q', ['read', 'write'], { kind: 'record', id: c });
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf3-P', a.map, ticketA])
        expect(text, what).not.toContain(canary);
    };

    // The positive controls: P reads and revises map A; Q reads map C.
    const readsA = await openMapAs(p, a.key);
    expect(readsA.find('[data-map-section="destination"]')?.textContent).toContain('canary-wf3-P');
    const revised = await w.as(p, { command: 'map.revise', ...(await at(a.map)), notes: 'by P' });
    expect((revised as { code?: string }).code).toBeUndefined();
    const readsC = await openMapAs(q, await keyOf(w, c));
    expect(readsC.find('[data-map-section="destination"]')).not.toBeNull();

    // The crossing: Q, in the same business and client, reads and writes none of map A.
    const crossed = await openMapAs(q, a.key);
    expect(crossed.find('[data-map-section]')).toBeNull();
    expect(crossed.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    clean('Q on map A', crossed.text());
    const version = await w.revisionOf(a.map);
    const edit = await w.as(q, { command: 'map.revise', ...(await at(a.map)), notes: 'crossed' });
    expect((edit as { code?: string }).code).toBe('SCOPE_NOT_GRANTED');
    clean('Q revising map A', JSON.stringify(edit));
    expect(await w.revisionOf(a.map)).toBe(version);

    // A change of reader through the screen registry: P's unsaved notes are
    // shown to neither Q nor the next person who holds map A.
    const draft = 'wf3-unsaved-draft-of-p';
    const registered = await openRegisteredMap(w, open, p, a.key);
    await registered.page.click('button[data-edit="notes"]');
    await registered.page.type('textarea[name="notes"]', draft);
    expect(shown(registered.page)).toContain(draft);
    await registered.switchTo(q);
    expect(registered.page.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(shown(registered.page)).not.toContain(draft);
    clean('Q after the switch', shown(registered.page));
    const next = await w.member('wf3-person-p2', ['read', 'write'], { kind: 'record', id: a.map });
    await registered.switchTo(next);
    expect(registered.page.find('[data-map-section="destination"]')).not.toBeNull();
    expect(registered.page.find('textarea[name="notes"]')).toBeNull();
    expect(shown(registered.page)).not.toContain(draft);
  });
});

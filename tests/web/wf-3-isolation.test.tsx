// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-3 isolation` (#636): the map view's three real crossings, another
// business, another client and a live delegation, with the refusal codes
// checked and the canaries absent from every page and answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { openMap, scopedMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

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

  it('WF-3 isolation', async () => {
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
});

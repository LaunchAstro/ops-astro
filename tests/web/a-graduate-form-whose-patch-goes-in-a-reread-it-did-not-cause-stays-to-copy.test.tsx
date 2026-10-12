// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// A graduate form with typed titles, never sent, whose fog patch another
// writer retires: when the map is next read for another reason, the titles
// stay on screen, explained, to copy or dismiss. The form made no attempt, so
// nothing about a graduation's outcome is drawn. Sol's design-check finding
// F2 on p17-chat-outbox-graduate-reconcile (#1448): the outbox and reconcile
// change must keep this path.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import type { Member } from '../commands/fixture.ts';
import { chart, openMap, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

const revisionShown = (page: Mounted) =>
  (page.find('[data-map]') as HTMLElement | null)?.dataset['revision'];

describe.skipIf(serverUrl === undefined)('A graduate form outlives its patch', () => {
  let w: CliWorld;
  let lead: Member;
  let other: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('mapgone', 'mapgoneweb');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    other = await w.member('other-writer', ['read', 'write']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  it('a graduate form never sent keeps its titles to copy when a reread it did not cause drops its patch', async () => {
    const m = await chart(
      w,
      lead,
      'unsent graduate',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['retired patch text', 'remaining patch text'],
    );
    const page = await openMap(w, open, lead, m.key);
    await page.click('[role="tab"][id="map-tab-fog"]');
    const ids = page.all('[data-patch]').map((one) => (one as HTMLElement).dataset['patch'] ?? '');
    const patch = ids[0] as string;
    await page.click(`button[data-graduate="${patch}"]`);
    await page.type('input[name="ticket-title-0"]', 'my unsent ticket');

    const at = { recordId: m.map, expectedRevision: await w.revisionOf(m.map) };
    must(await w.as(other, { command: 'map.revise', ...at, retire: [patch] }), 'map.revise');
    const latest = await w.revisionOf(m.map);

    // Something else makes the page read the map again: a notes save.
    await page.click('[role="tab"][id="map-tab-map"]');
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'a note');
    await page.click('button[data-save="notes"]');
    await until(page, () => revisionShown(page) === String(latest), 'the reread');
    await page.click('[role="tab"][id="map-tab-fog"]');

    expect(page.find(`[data-patch="${patch}"]`)).toBeNull();
    const gone = page.find('[data-graduate-gone]');
    expect(gone, 'the unsent titles are kept to copy').not.toBeNull();
    expect(gone?.textContent).toContain('my unsent ticket');
    expect(page.find('button[data-graduate-dismiss]')).not.toBeNull();
    expect(page.find('[data-graduate-unknown]')).toBeNull();
    await page.click('button[data-graduate-dismiss]');
    expect(page.text()).not.toContain('my unsent ticket');
  });
});

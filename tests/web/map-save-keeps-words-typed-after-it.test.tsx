// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// Words typed on the map page are never lost to a save: text typed while an
// earlier save is still on its way stays in the editor once that save
// applies, and a graduate form whose fog patch someone else removed stays on
// screen, explained, to copy or dismiss, without offering a save it cannot
// make.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import type { Member } from '../commands/fixture.ts';
import { tokenFor } from '../api/fixture.ts';
import { asBrowser } from '../support/sign-in.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import { pathOf, type CommandName } from '../../packages/core-wire/src/index.ts';
import { chart, openMap, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

const value = (page: Mounted, selector: string) =>
  (page.all(selector)[0] as HTMLInputElement | HTMLTextAreaElement | undefined)?.value;

const revisionShown = (page: Mounted) =>
  (page.find('[data-map]') as HTMLElement | null)?.dataset['revision'];

describe.skipIf(serverUrl === undefined)('A map save keeps the words typed after it', () => {
  let w: CliWorld;
  let lead: Member;
  let other: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('mapkeep', 'mapkeepweb');
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

  /**
   * The map page for `member`, whose first `command` is stored by the server
   * at once but answered only on `release`: `stored` settles when it is in.
   */
  async function openHeld(member: Member, mapKey: string, command: CommandName) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stored = () => {};
    const isStored = new Promise<void>((resolve) => {
      stored = resolve;
    });
    let held = false;
    const fetch = asBrowser(await tokenFor(member.presented.subject), async (url, init) => {
      const answer = await w.api.fetch(new Request(url, init));
      if (!held && url.endsWith(pathOf(command))) {
        held = true;
        stored();
        await released;
      }
      return answer;
    });
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: w.key,
      signedIn: true,
      fetch,
    });
    const page = await mount(
      <MapScreen client={client} grantKey={member.presented.subject} mapKey={mapKey} />,
    );
    open.push(page);
    await until(page, () => page.find('[data-map-section="destination"]') !== null, 'the map');
    return { page, stored: isStored, release };
  }

  it('notes typed while their save is on its way stay in the editor after that save applies', async () => {
    const m = await chart(w, lead, 'pending notes', [{ ref: 'a', title: 'a', type: 'task' }]);
    const { page, stored, release } = await openHeld(lead, m.key, 'map.revise');
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'first draft');
    await page.click('button[data-save="notes"]');
    await stored;
    await page.type('textarea[name="notes"]', 'first draft plus another paragraph');
    const after = await w.revisionOf(m.map);
    release();
    await until(page, () => revisionShown(page) === String(after), 'the save and its reread');

    expect(value(page, 'textarea[name="notes"]')).toBe('first draft plus another paragraph');
    const viewed = (await w.read(lead, { read: 'map.view', recordId: m.map })) as {
      map: { notes: { text: string } | null };
    };
    expect(viewed.map.notes?.text).toBe('first draft');
  });

  it('a notes save with nothing typed after it closes the editor once it applies', async () => {
    const m = await chart(w, lead, 'settled notes', [{ ref: 'a', title: 'a', type: 'task' }]);
    const { page, stored, release } = await openHeld(lead, m.key, 'map.revise');
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'only this');
    await page.click('button[data-save="notes"]');
    await stored;
    const after = await w.revisionOf(m.map);
    release();
    await until(page, () => revisionShown(page) === String(after), 'the save and its reread');
    expect(page.find('textarea[name="notes"]')).toBeNull();
    expect(page.find('[data-map-section="notes"]')?.textContent).toContain('only this');
  });

  it('graduate titles changed while the graduation is on its way are still on screen after it applies', async () => {
    const m = await chart(
      w,
      lead,
      'pending graduate',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['pending graduate patch'],
    );
    const { page, stored, release } = await openHeld(lead, m.key, 'map.graduate');
    await page.click('[role="tab"][id="map-tab-fog"]');
    const patch = (page.find('[data-patch]') as HTMLElement).dataset['patch'] as string;
    await page.click(`button[data-graduate="${patch}"]`);
    await page.type('input[name="ticket-title-0"]', 'sent ticket');
    await page.click('button[data-graduate-save]');
    await stored;
    await page.type('input[name="ticket-title-0"]', 'sent ticket and a later thought');
    const after = await w.revisionOf(m.map);
    release();
    await until(page, () => revisionShown(page) === String(after), 'the graduation and its reread');

    expect(page.find(`[data-patch="${patch}"]`)).toBeNull();
    expect(page.find('[data-graduate-gone]')?.textContent).toContain(
      'sent ticket and a later thought',
    );
  });

  it('a graduate form whose patch someone else removed stays on screen, explained, to copy or dismiss', async () => {
    const m = await chart(
      w,
      lead,
      'removed patch',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['removed patch text'],
    );
    const page = await openMap(w, open, lead, m.key);
    await page.click('[role="tab"][id="map-tab-fog"]');
    const patch = (page.find('[data-patch]') as HTMLElement).dataset['patch'] as string;
    await page.click(`button[data-graduate="${patch}"]`);
    await page.type('input[name="ticket-title-0"]', 'my first ticket');
    await page.click('button[data-add-ticket]');
    await page.type('input[name="ticket-title-1"]', 'my second ticket');

    const at = { recordId: m.map, expectedRevision: await w.revisionOf(m.map) };
    must(await w.as(other, { command: 'map.revise', ...at, retire: [patch] }), 'map.revise');
    const latest = await w.revisionOf(m.map);
    await page.click('button[data-graduate-save]');
    await until(
      page,
      () =>
        page.find('[data-map-failure]')?.textContent?.includes('VERSION_STALE') === true &&
        revisionShown(page) === String(latest),
      'the stale refusal and the reread',
    );

    const gone = page.find('[data-graduate-gone]');
    expect(gone?.textContent).toContain('no longer exists');
    expect(gone?.textContent).toContain('my first ticket');
    expect(gone?.textContent).toContain('my second ticket');
    // Nothing offers to save it again: there is no patch to graduate.
    expect(page.find('button[data-graduate-save]')).toBeNull();
    expect(page.text()).not.toContain('save it again');

    await page.click('button[data-graduate-dismiss]');
    expect(page.find('[data-graduate-gone]')).toBeNull();
    expect(page.text()).not.toContain('my first ticket');
  });
});

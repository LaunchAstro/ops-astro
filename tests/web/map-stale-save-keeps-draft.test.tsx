// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// A save the server refuses VERSION_STALE, because someone else revised the
// map after the editor opened, keeps what the person typed: the notes editor,
// the "not yet specified" line and the graduate form each stay open with their
// words over the reread map, the conflict is shown, and a second save writes
// the kept words over the latest version.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import type { Member } from '../commands/fixture.ts';
import { chart, openMap, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

/** Save, then wait for the stale refusal and the reread of the latest map. */
async function staleSave(page: Mounted, save: string, revision: number): Promise<void> {
  await page.click(save);
  await until(
    page,
    () =>
      page.find('[data-map-failure]')?.textContent?.includes('VERSION_STALE') === true &&
      (page.find('[data-map]') as HTMLElement | null)?.dataset['revision'] === String(revision),
    'the stale refusal and the reread',
  );
}

const value = (page: Mounted, selector: string) =>
  (page.all(selector)[0] as HTMLInputElement | HTMLTextAreaElement | undefined)?.value;

describe.skipIf(serverUrl === undefined)('A stale map save keeps the typed draft', () => {
  let w: CliWorld;
  let lead: Member;
  let other: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('mapstale', 'mapstaleweb');
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

  /** Someone else revises the map while the page holds an older revision. */
  async function reviseElsewhere(map: string, destination: string): Promise<number> {
    const at = { recordId: map, expectedRevision: await w.revisionOf(map) };
    must(await w.as(other, { command: 'map.revise', ...at, destination }), 'map.revise');
    return await w.revisionOf(map);
  }

  it('a stale notes save keeps the typed notes, shows the conflict, and saves them on the second try', async () => {
    const m = await chart(w, lead, 'stale notes', [{ ref: 'a', title: 'a', type: 'task' }]);
    const page = await openMap(w, open, lead, m.key);
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'three paragraphs of my own');
    const revision = await reviseElsewhere(m.map, 'moved on by someone else');
    await staleSave(page, 'button[data-save="notes"]', revision);
    expect(value(page, 'textarea[name="notes"]')).toBe('three paragraphs of my own');
    expect(page.find('[data-map-conflict]')).not.toBeNull();
    expect(page.text()).toContain('moved on by someone else');

    await page.click('button[data-save="notes"]');
    await until(
      page,
      () =>
        page.find('textarea[name="notes"]') === null &&
        (page.find('[data-map-section="notes"]')?.textContent ?? '').includes('three paragraphs'),
      'the kept notes, saved',
    );
    expect(page.find('[data-map-conflict]')).toBeNull();
  });

  it('a stale "not yet specified" line keeps its typed text', async () => {
    const m = await chart(w, lead, 'stale fog line', [{ ref: 'a', title: 'a', type: 'task' }]);
    const page = await openMap(w, open, lead, m.key);
    await page.type('input[name="fog"]', 'a line I typed');
    const revision = await reviseElsewhere(m.map, 'fog line moved on');
    await staleSave(page, 'button[data-add="fog"]', revision);
    expect(value(page, 'input[name="fog"]')).toBe('a line I typed');
    expect(page.find('[data-map-conflict]')).not.toBeNull();
  });

  it('a stale graduate keeps the form open with its typed ticket titles', async () => {
    const m = await chart(
      w,
      lead,
      'stale graduate',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['stale graduate patch'],
    );
    const page = await openMap(w, open, lead, m.key);
    await page.click('[role="tab"][id="map-tab-fog"]');
    const patch = (page.find('[data-patch]') as HTMLElement).dataset['patch'] as string;
    await page.click(`button[data-graduate="${patch}"]`);
    await page.type('input[name="ticket-title-0"]', 'my first ticket');
    await page.click('button[data-add-ticket]');
    await page.type('input[name="ticket-title-1"]', 'my second ticket');
    const revision = await reviseElsewhere(m.map, 'graduate moved on');
    await staleSave(page, 'button[data-graduate-save]', revision);
    expect(value(page, 'input[name="ticket-title-0"]')).toBe('my first ticket');
    expect(value(page, 'input[name="ticket-title-1"]')).toBe('my second ticket');
    expect(page.find('[data-map-conflict]')).not.toBeNull();
  });
});

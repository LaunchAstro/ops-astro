// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The map page reads the map again after every write it applies, and that
// reread redraws the views from the server's answer. The filters are held
// above the read, so a write made from the narrowed tickets view leaves it
// narrowed: the same type and text, and the same rows.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import type { Member } from '../commands/fixture.ts';
import { chart, openMap, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

const rows = (page: Mounted) =>
  page.all('[data-ticket-row]').map((row) => (row as HTMLElement).dataset['ticketRow']);

describe.skipIf(serverUrl === undefined)('the map filters through a write', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('mapfilters', 'mapfiltersweb');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  it('a blocking set from the filtered tickets view keeps the filters and the rows through the reread', async () => {
    const { map, key, tickets } = await chart(w, lead, 'filtered write', [
      { ref: 'kept', title: 'kept research', type: 'research' },
      { ref: 'other', title: 'other research', type: 'research' },
      { ref: 'build', title: 'kept build', type: 'build' },
    ]);
    const [kept, build] = [tickets['kept'], tickets['build']] as [string, string];
    const page = await openMap(w, open, lead, key);
    await page.click('[role="tab"][id="map-tab-tickets"]');
    await page.choose('select[name="filter-type"]', 'research');
    await page.type('input[name="filter-text"]', 'kept');
    expect(rows(page)).toStrictEqual([kept]);

    await page.choose(`select[name="block-${kept}"]`, build);
    await page.click(`button[data-block="${kept}"]`);
    await until(
      page,
      () => page.find(`[data-ticket-row="${kept}"] [data-blocked-by="${build}"]`) !== null,
      'the blocking and the reread',
    );

    expect((page.find('[data-map]') as HTMLElement).dataset['map']).toBe(map);
    expect((page.find('select[name="filter-type"]') as HTMLSelectElement).value).toBe('research');
    expect((page.find('input[name="filter-text"]') as HTMLInputElement).value).toBe('kept');
    expect(rows(page)).toStrictEqual([kept]);
    expect(page.find('[role="tab"][id="map-tab-tickets"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

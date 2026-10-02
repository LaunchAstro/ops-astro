// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-3: a late earlier-days page for an old first page must not
// wipe the earlier days already loaded for the current one.
//
// Load earlier days is pressed on the newest days and its page held. A search
// then draws a new first page, Load earlier days is pressed on that, and its
// page lands. When the old page finally arrives it belongs to a first page no
// longer drawn: it is dropped, and the current first page keeps its own
// earlier days and its own Load earlier state.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  FIRST,
  SECOND,
  THIRD,
  drawn,
  event,
  held,
  openWorkLog,
  page,
  pinZone,
  projects,
  server,
  tick,
  zone,
} from './work-log-stand-in.tsx';

pinZone();

/** The first page for `zzz`, with more before it. */
const FOUND = page(
  [{ day: '2026-09-27', events: [event('z1', '2026-09-27T02:00:00Z', 'OPS-7', 'Zip the tent')] }],
  true,
);

describe('REVIEW-MAIN-2B1-3 a late earlier page for an old first page', () => {
  it('REVIEW-MAIN-2B1-3: a late earlier-days page for an old first page does not wipe the current one', async () => {
    const r1 = held();
    const api = server([{ body: FIRST }, r1.response, { body: FOUND }, { body: SECOND }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    // R1: the page before the newest days, held.
    await view.click('.act__more');
    expect(api.asked[1]).toEqual({ timeZone: zone, before: '2026-09-22' });

    // F2: a search draws a new first page.
    await view.type('input[type="search"]', 'zzz');
    await tick();
    expect(api.asked[2]).toMatchObject({ before: null, query: 'zzz' });
    expect(drawn(view)).toEqual(['z1']);

    // R2: the page before F2 lands.
    await view.click('.act__more');
    await tick();
    expect(api.asked[3]).toEqual({ timeZone: zone, before: '2026-09-27', query: 'zzz' });
    expect(drawn(view)).toEqual(['z1', 'e3']);
    expect(view.find('.act__more')).toBeNull();

    // R1 arrives late, for a first page no longer drawn.
    r1.release(THIRD);
    await tick();

    expect(drawn(view)).toEqual(['z1', 'e3']);
    expect(view.text()).not.toContain('Sweep the yard');
    // SECOND said there is nothing earlier, so there is still no button.
    expect(view.find('.act__more')).toBeNull();
    expect(api.asked).toHaveLength(4);
    await view.unmount();
  });
});

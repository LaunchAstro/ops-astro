// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4 in the web application: the Work log's paging per the long-lists
// ruling. `Load earlier days` walks `before` back a page of whole days at a
// time; one page is asked for at a time; a page that arrives after the reader
// changed is dropped, not drawn under the new reader.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  FIRST,
  SECOND,
  SECOND_OF_THREE,
  THIRD,
  drawn,
  held,
  openWorkLog,
  page,
  pinZone,
  projects,
  refused,
  server,
  tick,
  zone,
} from './work-log-stand-in.tsx';

pinZone();

describe('MP-8-4 paging per the long-lists ruling (web)', () => {
  it('Load earlier days asks for the days before the last one drawn and adds them below', async () => {
    const api = server([{ body: FIRST }, { body: SECOND }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await tick();
    expect(api.asked[1]).toEqual({ timeZone: zone, before: '2026-09-22' });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(view.find('.act__more')).toBeNull();
    await view.unmount();
  });

  it('each press continues from the last day drawn, and every page stays in order', async () => {
    const api = server([{ body: FIRST }, { body: SECOND_OF_THREE }, { body: THIRD }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await tick();
    await view.click('.act__more');
    await tick();
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', '2026-09-15']);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(view.find('.act__more')).toBeNull();
    await view.unmount();
  });

  it('an earlier page that fails says so and keeps the days already drawn', async () => {
    const api = server([
      { body: FIRST },
      { body: refused('SCOPE_NOT_GRANTED', ['task']), status: 403 },
    ]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await tick();
    expect(view.all('.act__row')).toHaveLength(2);
    expect(view.find('[data-ledger-more="failed"]')?.getAttribute('role')).toBe('alert');
    expect(view.find('.act__more')).not.toBeNull();
    await view.unmount();
  });
});

describe('MP-8-4 paging per the long-lists ruling (web), races', () => {
  it('a second press while a page is on its way asks once', async () => {
    const later = held();
    const api = server([{ body: FIRST }, later.response]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(true);
    await view.click('.act__more');
    later.release(SECOND);
    await tick();
    expect(api.asked).toHaveLength(2);
    expect(view.all('.act__row')).toHaveLength(3);
    await view.unmount();
  });
});

describe('MP-8-4 paging per the long-lists ruling (web), a changed reader', () => {
  it('a page that arrives after the reader changed is dropped, not drawn under the new reader', async () => {
    const later = held();
    const api = server([{ body: FIRST }, later.response, { body: page([], false) }]);
    const view = await mount(projects(api.fetch, 'alpha:owner'));
    await tick();
    await openWorkLog(view);
    await view.click('.act__more');

    await view.render(projects(api.fetch, 'alpha:other'));
    await tick();
    later.release(SECOND);
    await tick();

    expect(api.asked).toHaveLength(3);
    expect(api.asked[2]).toEqual({ timeZone: zone, before: null });
    expect(view.all('.act__row')).toHaveLength(0);
    expect(view.text()).not.toContain('Oil the hinge');
    await view.unmount();
  });

  it('an old reader’s late page leaves the new reader’s own page on its way', async () => {
    const old = held();
    const own = held();
    const api = server([{ body: FIRST }, old.response, { body: FIRST }, own.response]);
    const view = await mount(projects(api.fetch, 'alpha:owner'));
    await tick();
    await openWorkLog(view);
    await view.click('.act__more');
    await view.render(projects(api.fetch, 'alpha:other'));
    await tick();
    await view.click('.act__more');

    old.release(SECOND);
    await tick();
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(true);
    expect(drawn(view)).toEqual(['e1', 'e2']);

    own.release(SECOND);
    await tick();
    expect(api.asked).toHaveLength(4);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await view.unmount();
  });
});

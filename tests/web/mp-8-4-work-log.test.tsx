// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4 in the web application: the Projects page's Work log tab placing the
// ledger face over `task.ledger`, against a stand-in that answers the way the
// API does (`packages/core-commands/src/reads/ledger.ts`).
//
// "A tab reaches it": a tab on `/projects/`, reached by `#worklog` as in the
// mockup, reading only once opened. The reader's zone groups the days, with
// UTC when the server does not know it. Paging is in `-paging`.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  FIRST,
  SECOND,
  TAB,
  drawn,
  openWorkLog,
  opened,
  pinZone,
  projects,
  refused,
  server,
  tick,
  zone,
} from './work-log-stand-in.tsx';

pinZone();

describe('MP-8-4 a tab reaches it', () => {
  it('the Projects page carries a Work log tab, and its read waits until the tab is opened', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();

    const tabs = view.all(TAB).map((t) => t.textContent);
    expect(tabs).toEqual(['Board', 'Work log']);
    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Board');
    expect(api.asked).toHaveLength(0);
    expect(view.all('.act__row')).toHaveLength(0);

    await openWorkLog(view);
    expect(api.asked).toEqual([{ timeZone: zone, before: null }]);
    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
    expect(drawn(view)).toEqual(['e1', 'e2']);
    expect(window.location.hash).toBe('#worklog');
    await view.unmount();
  });

  it('`/projects/#worklog` opens on the Work log', async () => {
    window.history.replaceState(null, '', '/projects/#worklog');
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();

    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(2);
    await view.unmount();
  });

  it('back on the Board, the Work log keeps what it drew and reads nothing again', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);
    await view.click(`${TAB}:nth-child(1)`);
    await openWorkLog(view);

    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(2);
    expect(window.location.hash).toBe('#worklog');
    await view.unmount();
  });
});

describe('MP-8-4 rows open the task (web)', () => {
  it('a plain press on a row goes to that task’s own address', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('[data-event="e2"] .act__text');
    expect(opened).toEqual(['/task/OPS-2']);
    expect(view.find('[data-event="e1"] a')?.getAttribute('href')).toBe('/task/OPS-1');
    await view.unmount();
  });
});

describe('MP-8-4 the reader’s zone (web)', () => {
  it('a zone the server does not know falls back to UTC, and the days are drawn in it', async () => {
    const api = server([
      { body: refused('FIELD_VALUE_INVALID', ['timeZone']), status: 400 },
      { body: FIRST },
      { body: SECOND },
    ]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    expect(api.asked.map((body) => body['timeZone'])).toEqual([zone, 'UTC']);
    expect(view.all('.act__row')).toHaveLength(2);
    expect(view.find('[data-event="e1"] .act__t')?.textContent).toBe('02:00');

    await view.click('.act__more');
    await tick();
    expect(api.asked[2]).toEqual({ timeZone: 'UTC', before: '2026-09-22' });
    await view.unmount();
  });

  it('any other refusal is drawn as a refusal, with no rows and no second try', async () => {
    const api = server([{ body: refused('NOT_FOUND', ['task']), status: 404 }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(0);
    expect(view.text()).toContain('You are not permitted to see this work log.');
    await view.unmount();
  });
});

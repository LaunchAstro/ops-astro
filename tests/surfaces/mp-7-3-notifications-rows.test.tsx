// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3, the Notifications panel and `/inbox/`: closed items, rows and the
// gesture law, browsing, the bell and the one list. The panel draws `inbox.read` and `inbox.count` as they arrive; it
// builds no second queue and changes no state. One test per supporting
// checklist line; the server's isolation crossings are INB-1's read.

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Bell, InboxPage, NotificationsPanel } from '../../packages/ui/src/index.ts';
import { ITEMS, item, pane, press, props, rowKeys, tabBadge } from './inbox-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('MP-7-3 closed disclosure', () => {
  it('closed items sit in a shut disclosure that states its count and opens in place', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const closed = mounted.find('details.nt__closed') as HTMLDetailsElement | null;
    expect(closed?.open).toBe(false);
    expect(closed?.querySelector('summary.nt__summary')?.textContent).toBe(
      '1 closed: answered and kept',
    );
    await mounted.click('summary.nt__summary');
    expect(closed?.open).toBe(true);
  });
});

describe('MP-7-3 answered items kept', () => {
  it('a cleared or withdrawn item stays, in the tab it came from, inside its client group', async () => {
    const withdrawn = item('a4', {
      group: 'acme',
      owed: false,
      counted: false,
      workState: 'withdrawn',
      closedAt: '2026-09-26T00:00:00Z',
    });
    mounted = await mount(<NotificationsPanel {...props({ items: [...ITEMS, withdrawn] })} />);
    const owedClosed = pane(mounted, 'owed')?.querySelector('.nt__closed');
    expect(rowKeys(owedClosed)).toEqual(['/task/T-a3']);
    const infoClosed = pane(mounted, 'info')?.querySelector('.nt__closed');
    expect(rowKeys(infoClosed)).toEqual(['/task/T-a4']);
    expect(owedClosed?.closest('.nt__grp')?.querySelector('.nt__gname')?.textContent).toBe('Acme');
  });
});

describe('MP-7-3 row opens its task', () => {
  it('every row is a link to its own task', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    expect(rowKeys(pane(mounted, 'owed'))).toEqual([
      '/task/T-b2',
      '/task/T-b1',
      '/task/T-c1',
      '/task/T-a1',
      '/task/T-a3',
    ]);
    expect(rowKeys(pane(mounted, 'info'))).toEqual(['/task/T-a2', '/task/T-i1']);
    expect(mounted.find('a[href="/task/T-c1"] .nt__text')?.textContent).toBe('Task c1');
  });
});

describe('MP-7-3 open by gesture law', () => {
  it('a plain press opens the task in place, Shift beside, and a new-tab press is left to the browser', async () => {
    const p = props();
    mounted = await mount(<NotificationsPanel {...p} />);
    expect(await press(mounted, 'a[href="/task/T-b1"]')).toBe(true);
    expect(await press(mounted, 'a[href="/task/T-b2"]', { shiftKey: true })).toBe(true);
    expect(await press(mounted, 'a[href="/task/T-c1"]', { metaKey: true })).toBe(false);
    expect(await press(mounted, 'a[href="/task/T-c1"]', { ctrlKey: true })).toBe(false);
    expect(p.opened).toEqual([
      { kind: 'task', key: 'T-b1', beside: false },
      { kind: 'task', key: 'T-b2', beside: true },
    ]);
  });
});

describe('MP-7-3 client name opens client', () => {
  it("a group head's client name opens that client by the same law; no client, no link", async () => {
    const p = props();
    mounted = await mount(<NotificationsPanel {...p} />);
    expect(await press(mounted, 'a.nt__gname[href="/clients/birch/"]')).toBe(true);
    expect(await press(mounted, 'a.nt__gname[href="/clients/acme/"]', { shiftKey: true })).toBe(
      true,
    );
    expect(p.opened).toEqual([
      { kind: 'client', key: 'birch', beside: false },
      { kind: 'client', key: 'acme', beside: true },
    ]);
    const internal = pane(mounted, 'info')?.querySelectorAll('.nt__gname').item(1);
    expect(internal?.textContent).toBe('Internal');
    expect(internal?.tagName).toBe('SPAN');
  });
});

describe('MP-7-3 counts unchanged by browsing', () => {
  it('switching tabs, opening the closed items and opening rows change no count and call nothing else', async () => {
    const p = props();
    mounted = await mount(<NotificationsPanel {...p} />);
    const before = [
      tabBadge(mounted, 0),
      tabBadge(mounted, 1),
      mounted.find('.nt__sum')?.textContent,
    ];
    await mounted.click('[role="tab"]:nth-child(2)');
    await mounted.click('[role="tab"]:nth-child(1)');
    await mounted.click('summary.nt__summary');
    await press(mounted, 'a[href="/task/T-b1"]');
    await act(() => {
      const owed = pane(mounted!, 'owed') as HTMLElement | null;
      if (owed !== null) owed.scrollTop = 200;
      owed?.dispatchEvent(new Event('scroll'));
    });
    expect([
      tabBadge(mounted, 0),
      tabBadge(mounted, 1),
      mounted.find('.nt__sum')?.textContent,
    ]).toEqual(before);
    expect(p.opened).toEqual([{ kind: 'task', key: 'T-b1', beside: false }]);
  });
});

describe('MP-7-3 bell count at load', () => {
  it('the bell carries the count in its first paint, with no effect to wait for', () => {
    const html = renderToStaticMarkup(<Bell owedCount={4} onOpen={() => null} />);
    expect(html).toContain('>4<');
    expect(html).toContain('aria-label="Notifications, 4 owed a response"');
  });

  it('nothing owed draws no badge, not a zero', () => {
    const html = renderToStaticMarkup(<Bell owedCount={0} onOpen={() => null} />);
    expect(html).not.toContain('cbadge');
    expect(html).toContain('aria-label="Notifications"');
  });
});

describe('MP-7-3 inbox one list', () => {
  it('/inbox/ is the same list in full-page form: the same rows, in order, one owed count', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const panelRows = mounted.all('a.nt__row').map((row) => row.getAttribute('href'));
    const panelSum = mounted.find('.nt__sum')?.textContent;
    await mounted.render(<InboxPage {...props()} />);
    expect(mounted.find('h1')?.textContent).toBe('Inbox');
    expect(mounted.all('a.nt__row').map((row) => row.getAttribute('href'))).toEqual(panelRows);
    expect(mounted.all('.nt__sum').map((line) => line.textContent)).toEqual([panelSum]);
    expect(mounted.all('[role="tablist"]')).toHaveLength(1);
  });
});

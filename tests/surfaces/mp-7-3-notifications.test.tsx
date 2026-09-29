// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3, the Notifications panel and `/inbox/`: the designed face of INB-1's
// inbox. The panel draws `inbox.read` and `inbox.count` as they arrive; it
// builds no second queue and changes no state. One test per supporting
// checklist line; the server's isolation crossings are INB-1's read.

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Bell,
  InboxPage,
  NotificationsPanel,
  bandHeads,
  groupsOf,
  type InboxGroupRef,
  type InboxItem,
  type NotificationsProps,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const CANARY = 'CANARY-withheld-7f3a';

type Grouped = InboxItem & { readonly group: string };

function item(id: string, over: Partial<InboxItem> & { readonly group: string }): Grouped {
  return {
    id,
    reason: 'assignment',
    workState: 'open',
    access: 'readable',
    owed: true,
    counted: true,
    raisedAt: '2026-09-20T00:00:00Z',
    closedAt: null,
    task: { key: `T-${id}`, title: `Task ${id}` },
    ...over,
  };
}

const GROUPS: Readonly<Record<string, InboxGroupRef>> = {
  acme: { key: 'acme', name: 'Acme', href: '/clients/acme/' },
  birch: { key: 'birch', name: 'Birch', href: '/clients/birch/' },
  cedar: { key: 'cedar', name: 'Cedar', href: '/clients/cedar/' },
};
const INTERNAL: InboxGroupRef = { key: 'internal', name: 'Internal' };

const ITEMS: readonly Grouped[] = [
  item('a1', { group: 'acme', raisedAt: '2026-09-20T00:00:00Z' }),
  item('a2', {
    group: 'acme',
    owed: false,
    counted: false,
    reason: 'run_finished',
    raisedAt: '2026-09-28T00:00:00Z',
  }),
  item('a3', {
    group: 'acme',
    workState: 'cleared',
    counted: false,
    reason: 'decision',
    raisedAt: '2026-09-18T00:00:00Z',
    closedAt: '2026-09-25T00:00:00Z',
  }),
  item('b1', { group: 'birch', raisedAt: '2026-09-10T00:00:00Z' }),
  item('b2', { group: 'birch', reason: 'mention', raisedAt: '2026-09-11T00:00:00Z' }),
  item('c1', { group: 'cedar', reason: 'decision', raisedAt: '2026-09-26T00:00:00Z' }),
  item('i1', {
    group: 'internal',
    owed: false,
    counted: false,
    reason: 'run_finished',
    raisedAt: '2026-09-27T00:00:00Z',
  }),
  // What INB-1 withholds after the recipient loses read: never drawn, whatever it carries.
  item('w1', {
    group: 'acme',
    access: 'withheld',
    counted: false,
    task: { key: 'T-w1', title: CANARY },
  }),
  item('g1', { group: 'birch', access: 'gone', counted: false, task: undefined }),
];

interface Opened {
  readonly kind: 'task' | 'client';
  readonly key: string;
  readonly beside: boolean;
}

function props(over: Partial<NotificationsProps> = {}): NotificationsProps & {
  readonly opened: Opened[];
} {
  const opened: Opened[] = [];
  return {
    items: ITEMS,
    owedCount: 4,
    groupOf: (entry) => GROUPS[(entry as Grouped).group] ?? INTERNAL,
    taskHref: (key) => `/task/${encodeURIComponent(key)}`,
    onOpenTask: (key, how) => opened.push({ kind: 'task', key, beside: how.beside }),
    onOpenClient: (key, how) => opened.push({ kind: 'client', key, beside: how.beside }),
    ...over,
    opened,
  };
}

const pane = (m: Mounted, id: 'owed' | 'info'): Element | null =>
  m.find(`[role="tabpanel"][id$="${id}"]`);
const rowKeys = (scope: Element | null | undefined): readonly string[] =>
  [...(scope?.querySelectorAll('a.nt__row') ?? [])].map((a) => a.getAttribute('href') ?? '');
const tabBadge = (m: Mounted, index: number): string =>
  m.all('[role="tab"]')[index]?.querySelector('.cbadge')?.textContent ?? '';

async function press(m: Mounted, selector: string, init: MouseEventInit = {}): Promise<boolean> {
  const target = m.find(selector);
  let prevented = false;
  await act(async () => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    target?.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

describe('MP-7-3 two tabs with counts', () => {
  it('draws owed and not owed tabs, each with its count, owed first', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const tabs = mounted.all('[role="tab"]');
    expect(tabs.map((tab) => tab.firstChild?.textContent)).toEqual([
      'Owed a response',
      'No response needed',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabBadge(mounted, 0)).toBe('4');
    expect(tabBadge(mounted, 1)).toBe('2');
  });

  it('a tab with nothing in it draws no count at all, not a zero', async () => {
    const quiet = ITEMS.filter((entry) => entry.owed);
    mounted = await mount(<NotificationsPanel {...props({ items: quiet })} />);
    expect(mounted.all('[role="tab"]')[1]?.querySelector('.cbadge')).toBeNull();
  });
});

describe('MP-7-3 count', () => {
  it('the owed count, the headline and the bell all show inbox.count, never a local tally', async () => {
    mounted = await mount(
      <>
        <Bell owedCount={4} onOpen={() => undefined} />
        <NotificationsPanel {...props()} />
      </>,
    );
    // The read holds four readable owed items and a withheld one; only the count decides.
    expect(tabBadge(mounted, 0)).toBe('4');
    expect(mounted.find('.nt__sum')?.textContent).toBe('4 owed a response');
    expect(mounted.find('.bell .cbadge')?.textContent).toBe('4');
    await mounted.render(<NotificationsPanel {...props({ owedCount: 3 })} />);
    expect(tabBadge(mounted, 0)).toBe('3');
  });
});

describe('MP-7-3 withheld', () => {
  it('an item INB-1 withholds or reports gone never shows in the panel, the page or a count', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    expect(mounted.text()).not.toContain(CANARY);
    expect(mounted.find('a[href="/task/T-w1"]')).toBeNull();
    expect(mounted.find('a[href="/task/T-g1"]')).toBeNull();
    expect(mounted.all('a.nt__row')).toHaveLength(7);
    await mounted.render(<InboxPage {...props()} />);
    expect(mounted.text()).not.toContain(CANARY);
    expect(mounted.all('a.nt__row')).toHaveLength(7);
  });
});

describe('MP-7-3 arrow keys', () => {
  it('left and right move between the two tabs', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const list = mounted.find('[role="tablist"]');
    const key = async (name: string): Promise<void> => {
      await act(async () => {
        list?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    };
    await key('ArrowRight');
    expect(mounted.all('[role="tab"]')[1]?.getAttribute('aria-selected')).toBe('true');
    expect((pane(mounted, 'info') as HTMLElement | null)?.hidden).toBe(false);
    expect((pane(mounted, 'owed') as HTMLElement | null)?.hidden).toBe(true);
    await key('ArrowLeft');
    expect(mounted.all('[role="tab"]')[0]?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('MP-7-3 client group order', () => {
  it('groups by client, most owed first, then by most recent activity; rows newest first', () => {
    const p = props();
    const owed = groupsOf(p.items, 'owed', p.groupOf);
    expect(owed.map((group) => group.ref.key)).toEqual(['birch', 'cedar', 'acme']);
    expect(owed[0]?.items.map((entry) => entry.id)).toEqual(['b2', 'b1']);
    expect(owed.map((group) => group.owe)).toEqual([2, 1, 1]);
    const info = groupsOf(p.items, 'info', p.groupOf);
    expect(info.map((group) => group.ref.key)).toEqual(['acme', 'internal']);
  });

  it('the mounted panel draws the groups in that order under their client names', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const heads = [...(pane(mounted, 'owed')?.querySelectorAll('.nt__gname') ?? [])];
    expect(heads.map((head) => head.textContent)).toEqual(['Birch', 'Cedar', 'Acme']);
  });
});

describe('MP-7-3 band heads', () => {
  it('draws band heads only when the tab holds two live bands', async () => {
    const p = props();
    expect(bandHeads(groupsOf(p.items, 'owed', p.groupOf))).toBe(false);
    const mixed = groupsOf(p.items, undefined, p.groupOf);
    expect(bandHeads(mixed)).toBe(true);
    mounted = await mount(<NotificationsPanel {...p} />);
    expect(mounted.find('.nt__bh')).toBeNull();
    expect(mounted.all('.nt__band').length).toBeGreaterThan(0);
  });
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
    await act(async () => {
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
    const html = renderToStaticMarkup(<Bell owedCount={4} onOpen={() => undefined} />);
    expect(html).toContain('>4<');
    expect(html).toContain('aria-label="Notifications, 4 owed a response"');
  });

  it('nothing owed draws no badge, not a zero', () => {
    const html = renderToStaticMarkup(<Bell owedCount={0} onOpen={() => undefined} />);
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

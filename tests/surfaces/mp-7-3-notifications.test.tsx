// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3, the Notifications panel and `/inbox/`: the designed face of INB-1's
// inbox. The panel draws `inbox.read` and `inbox.count` as they arrive; it
// builds no second queue and changes no state. One test per supporting
// checklist line; the server's isolation crossings are INB-1's read.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Bell,
  InboxPage,
  NotificationsPanel,
  bandHeads,
  groupsOf,
} from '../../packages/ui/src/index.ts';
import { CANARY, ITEMS, pane, props, tabBadge } from './inbox-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

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
        <Bell owedCount={4} onOpen={() => null} />
        <NotificationsPanel {...props()} />
      </>,
    );
    // The read holds four readable owed items and a withheld one; only the count decides.
    expect(tabBadge(mounted, 0)).toBe('4');
    expect(mounted.find('.nt__sum')?.textContent).toBe('4 owed a response');
    expect(mounted.find('.bell .cbadge')?.textContent).toBe('4');
    await mounted.render(<NotificationsPanel {...props({ owedCount: 3 })} />);
    expect(tabBadge(mounted, 0)).toBe('3');
    expect(mounted.find('.nt__sum')?.textContent).toBe('3 owed a response');
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
      await act(() => {
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

describe("MP-7-3 nothing waiting is said with the kit's one empty state", () => {
  it('an empty inbox and an empty tab each draw the one empty state, never a dialect', async () => {
    mounted = await mount(<NotificationsPanel {...props({ items: [], owedCount: 0 })} />);
    expect(mounted.find('.empty.empty--block .empty__title')?.textContent).toBe(
      'Nothing is waiting on you.',
    );
    expect(mounted.find('.empty__desc')?.textContent).toBe(
      'Assignments, decisions and mentions land here and stay until they are dealt with.',
    );
    const quiet = ITEMS.filter((entry) => entry.owed);
    await mounted.render(<NotificationsPanel {...props({ items: quiet })} />);
    expect(
      pane(mounted, 'info')?.querySelector('.empty.empty--inline .empty__title')?.textContent,
    ).toBe('Nothing new to read.');
    expect(mounted.find('.dp__empty')).toBeNull();
  });
});

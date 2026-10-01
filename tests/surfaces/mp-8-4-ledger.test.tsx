// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4, the activity ledger's face: events grouped under sticky day heads,
// rows that open their task, and paging by whole days with "Load earlier days"
// (R49). The events arrive from the ledger read over the event record; its
// grant filter, its isolation test and its search (C1) are the read's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, type LedgerDay, type LedgerProps } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const DAYS: readonly LedgerDay[] = [
  {
    day: '2026-09-29',
    events: [
      {
        id: 'e3',
        at: '2026-09-29T00:40:00Z',
        actorName: 'Ari',
        operation: 'task.complete',
        task: { key: 'T-2', title: 'Send the quote' },
      },
      {
        id: 'e2',
        at: '2026-09-28T23:05:00Z',
        actorName: 'Bo',
        operation: 'task.assign',
        task: { key: 'T-1', title: null },
      },
    ],
  },
  {
    day: '2026-09-28',
    events: [
      {
        id: 'e1',
        at: '2026-09-28T01:15:00Z',
        actorName: 'Ari',
        operation: 'task.create',
        task: { key: 'T-1', title: 'Book the shoot' },
      },
    ],
  },
  {
    day: '2026-09-24',
    events: [
      {
        id: 'e0',
        at: '2026-09-24T02:00:00Z',
        actorName: 'Cy',
        operation: 'task.some_later_command',
        task: { key: 'T-9', title: 'Old job' },
      },
    ],
  },
];

function props(over: Partial<LedgerProps> = {}): LedgerProps & {
  readonly opened: string[];
  readonly loads: number[];
} {
  const opened: string[] = [];
  const loads: number[] = [];
  return {
    days: DAYS,
    earlier: true,
    loading: false,
    today: '2026-09-29',
    timeZone: 'Australia/Brisbane',
    taskHref: (key) => `/task/${encodeURIComponent(key)}`,
    onOpenTask: (key) => opened.push(key),
    onLoadEarlier: () => loads.push(loads.length + 1),
    ...over,
    opened,
    loads,
  };
}

async function press(m: Mounted, selector: string, init: MouseEventInit = {}): Promise<boolean> {
  const target = m.all(selector)[0];
  let prevented = false;
  await act(() => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    target?.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

describe('MP-8-4 sticky day headings', () => {
  it('heads each day once, newest first, in words, and the head sticks', async () => {
    mounted = await mount(<Ledger {...props()} />);
    expect(mounted.all('.act__day').map((head) => head.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Thu 24 Sep',
    ]);
    const css = readFileSync(
      join(process.cwd(), 'packages/ui/src/styles/9-ledger.css'),
      'utf8',
    ).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    expect(css).toMatch(/\.act__day\s*\{[^}]*position: sticky;[^}]*top: 0;/u);
  });
});

describe('MP-8-4 rows say who did what to which task, and when', () => {
  it('draws the time in the reader zone, the kind in words, who, and the task', async () => {
    mounted = await mount(<Ledger {...props()} />);
    const rows = mounted.all('.act__row');
    expect(rows).toHaveLength(4);
    const first = rows[0];
    expect(first?.querySelector('.act__t')?.textContent).toBe('10:40');
    expect(first?.querySelector('.act__kind')?.textContent).toBe('Completed');
    expect(first?.querySelector('.act__who')?.textContent).toBe('Ari');
    expect(first?.querySelector('.act__text')?.textContent).toBe('Send the quote');
    expect(first?.querySelector('a.act__proj')?.textContent).toBe('T-2');
    // Brisbane is ten hours ahead: 23:05 on the 28th is 09:05 on the 29th.
    expect(rows[1]?.querySelector('.act__t')?.textContent).toBe('09:05');
    expect(rows[1]?.querySelector('.act__text')?.textContent).toBe('T-1');
    expect(rows[1]?.querySelector('.act__kind')?.textContent).toBe('Assigned');
  });

  it('a command the face has no word for still says something changed, never a raw name', async () => {
    mounted = await mount(<Ledger {...props()} />);
    const last = mounted.all('.act__row')[3];
    expect(last?.querySelector('.act__kind')?.textContent).toBe('Changed');
    expect(mounted.text()).not.toContain('task.some_later_command');
  });
});

describe('MP-8-4 rows open the task', () => {
  it('a plain press on the row or its task opens the task beside the ledger', async () => {
    const p = props();
    mounted = await mount(<Ledger {...p} />);
    expect(mounted.all('a.act__proj').map((link) => link.getAttribute('href'))).toEqual([
      '/task/T-2',
      '/task/T-1',
      '/task/T-1',
      '/task/T-9',
    ]);
    expect(await press(mounted, 'a.act__proj')).toBe(true);
    await press(mounted, '.act__row[data-event="e1"] .act__who');
    expect(p.opened).toEqual(['T-2', 'T-1']);
  });

  it('a modifier or middle press is left to the browser', async () => {
    const p = props();
    mounted = await mount(<Ledger {...p} />);
    expect(mounted.all('a.act__proj')).toHaveLength(4);
    expect(await press(mounted, 'a.act__proj', { metaKey: true })).toBe(false);
    expect(await press(mounted, 'a.act__proj', { ctrlKey: true })).toBe(false);
    expect(await press(mounted, 'a.act__proj', { button: 1 })).toBe(false);
    expect(p.opened).toEqual([]);
  });
});

describe('MP-8-4 paging per the long-lists ruling', () => {
  it('offers Load earlier days while earlier days exist, once per press, never while loading', async () => {
    const p = props();
    mounted = await mount(<Ledger {...p} />);
    const button = mounted.find('button.act__more');
    expect(button?.textContent).toBe('Load earlier days');
    await mounted.click('button.act__more');
    expect(p.loads).toEqual([1]);
    await mounted.render(<Ledger {...p} loading />);
    expect(mounted.find('button.act__more')?.hasAttribute('disabled')).toBe(true);
    expect(mounted.find('button.act__more')?.getAttribute('aria-busy')).toBe('true');
    await mounted.render(<Ledger {...p} earlier={false} />);
    expect(mounted.find('button.act__more')).toBeNull();
  });

  it('earlier days join below with their own heads, never split across a page', async () => {
    const p = props({ days: DAYS.slice(0, 2) });
    mounted = await mount(<Ledger {...p} />);
    expect(mounted.all('.act__day')).toHaveLength(2);
    await mounted.render(<Ledger {...p} days={DAYS} />);
    expect(mounted.all('.act__day').map((head) => head.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Thu 24 Sep',
    ]);
  });
});

describe('MP-8-4 empty ledger says what it holds', () => {
  it('draws the sentence and no list or paging when there is nothing', async () => {
    mounted = await mount(<Ledger {...props({ days: [], earlier: false })} />);
    // The kit's one empty state (MP-1-3), never the mockup's `act__none` dialect.
    expect(mounted.find('.empty.empty--block .empty__title')?.textContent).toBe(
      'Nothing has happened here yet.',
    );
    expect(mounted.find('.empty__desc')?.textContent).toBe(
      'Every change to a task you can see is listed here, newest first.',
    );
    expect(mounted.find('.act__none')).toBeNull();
    expect(mounted.find('.act__list')).toBeNull();
    expect(mounted.find('button.act__more')).toBeNull();
  });
});

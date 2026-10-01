// SPDX-License-Identifier: AGPL-3.0-only
//
// The MP-7-3 tests' one inbox: four clients' worth of INB-1 entries, one of
// them withheld with a planted title and one gone, and the panel's props.

import { act } from 'react';
import type { InboxGroupRef, InboxItem, NotificationsProps } from '../../packages/ui/src/index.ts';
import type { Mounted } from './mount.tsx';

export const CANARY = 'CANARY-withheld-7f3a';

export type Grouped = InboxItem & { readonly group: string };

export function item(id: string, over: Partial<InboxItem> & { readonly group: string }): Grouped {
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

export const GROUPS: Readonly<Record<string, InboxGroupRef>> = {
  acme: { key: 'acme', name: 'Acme', href: '/clients/acme/' },
  birch: { key: 'birch', name: 'Birch', href: '/clients/birch/' },
  cedar: { key: 'cedar', name: 'Cedar', href: '/clients/cedar/' },
};
export const INTERNAL: InboxGroupRef = { key: 'internal', name: 'Internal' };

export const ITEMS: readonly Grouped[] = [
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

export interface Opened {
  readonly kind: 'task' | 'client';
  readonly key: string;
  readonly beside: boolean;
}

export function props(over: Partial<NotificationsProps> = {}): NotificationsProps & {
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

export const pane = (m: Mounted, id: 'owed' | 'info'): Element | null =>
  m.find(`[role="tabpanel"][id$="${id}"]`);
export const rowKeys = (scope: Element | null | undefined): readonly string[] =>
  [...(scope?.querySelectorAll('a.nt__row') ?? [])].map((a) => a.getAttribute('href') ?? '');
export const tabBadge = (m: Mounted, index: number): string =>
  m.all('[role="tab"]')[index]?.querySelector('.cbadge')?.textContent ?? '';

export async function press(
  m: Mounted,
  selector: string,
  init: MouseEventInit = {},
): Promise<boolean> {
  const target = m.all(selector)[0];
  let prevented = false;
  await act(() => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    target?.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

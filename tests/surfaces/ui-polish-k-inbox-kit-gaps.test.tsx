// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH piece K (SL10 gaps 2-4): the Notifications tab count is the plain
// member, the selected tab's mark is placed under it, and each row leads with
// a kind mark. The look is held by tests/visual/look/inbox.ts; these hold what
// a reader and the tab strip do with it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationsPanel } from '../../packages/ui/src/index.ts';
import { item, press, props } from './inbox-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** What a screen reader reads from an element: its text outside aria-hidden parts. */
function spoken(node: Node): string {
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  return [...node.childNodes].map((child) => spoken(child)).join('');
}

describe('a tab count is plain text a reader still hears', () => {
  it('draws the count as the plain member, read as part of the tab', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const [owed, info] = mounted.all('[role="tab"]');
    expect(owed?.querySelector('.cbadge')?.className).toBe('cbadge cbadge--plain');
    expect(spoken(owed as Element)).toBe('Owed a response4');
    expect(spoken(info as Element)).toBe('No response needed2');
  });
});

describe('the selected tab carries the mark', () => {
  // jsdom lays nothing out: a tab is 10px a character, after the tabs before it.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent ?? '').length * 10;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement) {
        let x = 0;
        for (let at = this.previousElementSibling; at !== null; at = at.previousElementSibling)
          x += (at.textContent ?? '').length * 10;
        return x;
      },
    });
  });
  afterEach(() => {
    if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    if (left !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', left);
  });

  it('places the mark under the selected tab, and moves it on a switch', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    const mark = mounted.find('.cmtabs__mark') as HTMLElement;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect([mark.style.left, mark.style.width]).toEqual(['0px', '160px']);
    await press(mounted, '[role="tab"][id$="-tab-info"]');
    expect([mark.style.left, mark.style.width]).toEqual(['160px', '190px']);
  });

  it('places it again when a count changes the tab width', async () => {
    mounted = await mount(<NotificationsPanel {...props()} />);
    await mounted.render(<NotificationsPanel {...props({ owedCount: 12 })} />);
    expect((mounted.find('.cmtabs__mark') as HTMLElement).style.width).toBe('170px');
  });
});

describe('each row leads with its kind mark', () => {
  it('draws the mark before the text, hidden from a reader', async () => {
    const items = [
      item('m1', { group: 'acme', reason: 'mention' }),
      item('d1', { group: 'acme', reason: 'decision', raisedAt: '2026-09-19T00:00:00Z' }),
    ];
    mounted = await mount(<NotificationsPanel {...props({ items, owedCount: 2 })} />);
    const rows = mounted.all('a.nt__row');
    expect(rows.map((row) => row.firstElementChild?.className)).toEqual([
      'nt__mark nt__mark--team',
      'nt__mark nt__mark--client',
    ]);
    expect(rows.every((row) => row.firstElementChild?.getAttribute('aria-hidden') === 'true')).toBe(
      true,
    );
    expect(rows[0]?.querySelector('.nt__at')?.textContent).toBe('@');
    expect(rows[1]?.querySelector('.nt__mark svg')).not.toBeNull();
    expect(spoken(rows[0] as Element)).toBe('Task m1Mentioned you 20 Sept');
  });
});

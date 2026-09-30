// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-1b, d and e: the dock's frame as drawn. The rail, its callout, Close
// all, each X and the panel head, mounted alone with the props the application
// hands it, so every assertion is about the frame and not about a screen.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  Dock,
  type DockPanel,
  type DockProps,
  type DockTab,
} from '../../packages/ui/src/surfaces/Dock.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SHEET = readFileSync('packages/ui/src/styles/3-shell.css', 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = SHEET.indexOf(`${selector} {`);
  if (at < 0) return '';
  return SHEET.slice(at, SHEET.indexOf('}', at));
}

const tab = (id: string, label: string, open = false, count: string | null = null): DockTab => ({
  id,
  label,
  open,
  count,
});
const panel = (id: string, label: string, door: string): DockPanel => ({
  id,
  label,
  ariaLabel: label,
  door,
  canBack: false,
  canForward: false,
  body: <p data-body={id}>{label} body</p>,
});

interface Calls {
  readonly tab: [string, boolean][];
  readonly close: string[];
  readonly closeAll: number[];
  readonly door: string[];
}

let drawn: Mounted | undefined;
afterEach(async () => {
  await drawn?.unmount();
  drawn = undefined;
});

async function draw(
  tabs: readonly DockTab[],
  panels: readonly DockPanel[] = [],
): Promise<{ page: Mounted; calls: Calls }> {
  const calls: Calls = { tab: [], close: [], closeAll: [], door: [] };
  const props: DockProps = {
    tabs,
    panels,
    onTab: (id, shift) => calls.tab.push([id, shift]),
    onClose: (id) => calls.close.push(id),
    onCloseAll: () => calls.closeAll.push(1),
    onBack: () => undefined,
    onForward: () => undefined,
    onDoor: (href) => calls.door.push(href),
  };
  drawn = await mount(<Dock {...props} />);
  return { page: drawn, calls };
}

describe('MP-3-1 rail from registry', () => {
  it('draws one glyph per tab, in the order it is handed', async () => {
    const { page } = await draw([tab('todos', 'Projects'), tab('settings', 'Settings')]);
    const tabs = page.all('.dock__rail .dock__tab');
    expect(tabs.map((each) => each.getAttribute('data-panel'))).toEqual(['todos', 'settings']);
    expect(tabs.map((each) => each.querySelectorAll('svg.icon').length)).toEqual([1, 1]);
  });

  it('hands the shift key to the gesture with the tab id', async () => {
    const { page, calls } = await draw([tab('todos', 'Projects'), tab('settings', 'Settings')]);
    const [first, second] = page.all('.dock__tab') as HTMLElement[];
    await act(async () => {
      first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      second?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(calls.tab).toEqual([
      ['todos', false],
      ['settings', true],
    ]);
  });
});

describe('MP-3-1 floating rail', () => {
  it('is a 40px rail fixed to the right edge and centred on it', () => {
    const rail = rule('.dock__rail');
    expect(rail).toMatch(/width:\s*40px/u);
    expect(rule('.dock')).toMatch(/position:\s*fixed/u);
    expect(rule('.dock')).toMatch(/right:\s*0/u);
    expect(rule('.dock__rail')).toMatch(/top:\s*50%/u);
    expect(rule('.dock__rail')).toMatch(/translateY\(-50%\)/u);
  });
});

describe('MP-3-1 callout', () => {
  it('names each tab in a callout hidden from its accessible name, with no native title', async () => {
    const { page } = await draw([tab('settings', 'Settings')]);
    const button = page.find('.dock__tab');
    const tip = page.find('.dock__tablabel');
    expect(tip?.textContent).toBe('Settings');
    // The button's label already names the panel; the callout would say it twice.
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('Open Settings');
    expect(button?.hasAttribute('title')).toBe(false);
  });

  it('shows on hover and on keyboard focus only', () => {
    expect(SHEET).toMatch(
      /\.dock__tab:hover \.dock__tablabel,\s*\.dock__tab:focus-visible \.dock__tablabel/u,
    );
    expect(rule('.dock__tablabel')).toMatch(/display:\s*none/u);
    expect(rule('.dock__tablabel')).toMatch(/pointer-events:\s*none/u);
  });

  it('flips to the right side when the rail is within 150px of the left edge', async () => {
    const { page } = await draw([tab('settings', 'Settings')]);
    const dock = page.find('.dock') as HTMLElement;
    const rail = page.find('.dock__rail') as HTMLElement;
    const at = (left: number): void => {
      rail.getBoundingClientRect = () => ({ left }) as DOMRect;
    };
    at(149);
    await act(async () => {
      rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(dock.classList.contains('dock--tipflip')).toBe(true);
    at(151);
    await act(async () => {
      rail.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(dock.classList.contains('dock--tipflip')).toBe(false);
  });
});

describe('MP-3-1 close all', () => {
  it('is absent while nothing is open', async () => {
    const { page } = await draw([tab('settings', 'Settings')]);
    expect(page.find('.dock__closeall')).toBeNull();
  });

  it('shows once something is open and closes everything', async () => {
    const { page, calls } = await draw(
      [tab('todos', 'Projects', true), tab('settings', 'Settings', true)],
      [panel('todos', 'Projects', '/projects/'), panel('settings', 'Settings', '/settings')],
    );
    const button = page.find('.dock__closeall');
    expect(button?.getAttribute('aria-label')).toBe('Close all panels');
    await page.click('.dock__closeall');
    expect(calls.closeAll).toEqual([1]);
    expect(calls.close).toEqual([]);
  });
});

describe('MP-3-1 x closes own', () => {
  it('each X names and closes only its own panel', async () => {
    const { page, calls } = await draw(
      [tab('todos', 'Projects', true), tab('settings', 'Settings', true)],
      [panel('todos', 'Projects', '/projects/'), panel('settings', 'Settings', '/settings')],
    );
    const xs = page.all('.dpanel__x');
    expect(xs.map((x) => x.getAttribute('aria-label'))).toEqual([
      'Close Projects',
      'Close Settings',
    ]);
    await page.click('[data-panel-id="settings"] .dpanel__x');
    expect(calls.close).toEqual(['settings']);
    expect(calls.closeAll).toEqual([]);
  });
});

describe('MP-3-1 head', () => {
  it('has one divider, then back and forward beside the X, disabled but drawn', async () => {
    const { page } = await draw(
      [tab('settings', 'Settings', true)],
      [panel('settings', 'Settings', '/settings')],
    );
    const head = page.find('.dpanel__head') as HTMLElement;
    expect(head.querySelectorAll('.dpanel__div')).toHaveLength(1);
    const acts = [...head.querySelectorAll('.dpanel__acts > *')].map(
      (each) => each.getAttribute('data-act') ?? each.className,
    );
    expect(acts).toEqual(['door', 'dpanel__div', 'back', 'forward', 'close']);
    const back = head.querySelector('[data-act="back"]');
    expect(back?.getAttribute('aria-disabled')).toBe('true');
    expect(back?.getAttribute('aria-label')).toBe('Back, where the dock was');
    expect(head.querySelector('[data-act="forward"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('names the panel, never the item open in it', async () => {
    const { page } = await draw(
      [tab('task', 'Task', true)],
      [{ ...panel('task', 'Task', '/task/T-1'), body: <h2>Replace the boiler</h2> }],
    );
    expect(page.find('.dpanel__name')?.textContent).toBe('Task');
    expect(page.find('[data-panel-id="task"]')?.getAttribute('aria-label')).toBe('Task');
  });
});

describe('MP-3-1 door', () => {
  it('carries the address it is handed and asks the application to go there', async () => {
    const { page, calls } = await draw(
      [tab('todos', 'Projects', true)],
      [panel('todos', 'Projects', '/task/T-1')],
    );
    const door = page.find('[data-act="door"]');
    expect(door?.getAttribute('href')).toBe('/task/T-1');
    await page.click('[data-act="door"]');
    expect(calls.door).toEqual(['/task/T-1']);
  });
});

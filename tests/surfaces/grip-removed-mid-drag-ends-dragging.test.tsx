// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A resize grip that goes away mid-drag ends the drag. Folding the rail while
// its grip is held leaves the shell out of dragging mode (no resize cursor,
// text selectable again); closing the dragged panel leaves the dock out of
// it, so the next panel opens without it. Losing the pointer's capture ends
// the drag the same way.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Dock, type DockPanel, type DockProps } from '../../packages/ui/src/surfaces/Dock.tsx';
import { Shell, type ShellProps } from '../../packages/ui/src/surfaces/Shell.tsx';
import { dockOf } from './dock-props.ts';
import { mount, type Mounted } from './mount.tsx';

const press = async (grip: Element | null, type: string): Promise<void> => {
  if (grip === null) throw new Error('no grip');
  (grip as HTMLElement).setPointerCapture = () => {};
  await act(() => {
    grip.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: 300 }), { pointerId: 1 }),
    );
  });
};

const flagged = (page: Mounted, selector: string, flag: string): boolean =>
  Object.hasOwn((page.host.querySelector(selector) as HTMLElement).dataset, flag);

const SHELL: ShellProps = {
  face: 'agency',
  build: null,
  rail: [],
  here: '/projects/',
  title: 'Projects',
  dock: dockOf([]),
  railWidth: 240,
  onRailFold: () => {},
  onRailResize: () => {},
  onRailResizeEnd: () => {},
  children: null,
};

const panel: DockPanel = {
  id: 'todos',
  label: 'Projects',
  ariaLabel: 'Projects',
  door: '/projects/',
  canBack: false,
  canForward: false,
  body: null,
};
const dock = (panels: readonly DockPanel[]): DockProps => ({
  ...dockOf([]),
  panels,
  layout: { mode: 'floating', panelWidth: 550 },
});

describe('a resize grip removed mid-drag', () => {
  it('folding the rail while its grip is held leaves the shell out of dragging mode', async () => {
    const page = await mount(<Shell {...SHELL} />);
    await press(page.find('.railgrip'), 'pointerdown');
    expect(flagged(page, '.shell', 'railDragging')).toBe(true);
    await page.render(<Shell {...SHELL} railCollapsed />);
    expect(page.find('.railgrip')).toBeNull();
    expect(flagged(page, '.shell', 'railDragging')).toBe(false);
  });

  it('closing the dragged panel leaves the dock out of dragging mode when one reopens', async () => {
    const page = await mount(<Dock {...dock([panel])} />);
    await press(page.find('.dpanel__grip'), 'pointerdown');
    expect(flagged(page, '.dock', 'dragging')).toBe(true);
    await page.render(<Dock {...dock([])} />);
    expect(flagged(page, '.dock', 'dragging')).toBe(false);
    await page.render(<Dock {...dock([panel])} />);
    expect(flagged(page, '.dock', 'dragging')).toBe(false);
  });

  it('losing the pointer capture ends the drag', async () => {
    const page = await mount(<Dock {...dock([panel])} />);
    await press(page.find('.dpanel__grip'), 'pointerdown');
    expect(flagged(page, '.dock', 'dragging')).toBe(true);
    await press(page.find('.dpanel__grip'), 'lostpointercapture');
    expect(flagged(page, '.dock', 'dragging')).toBe(false);
  });
});

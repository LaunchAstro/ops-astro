// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { NotificationsPanel } from '../../packages/ui/src/surfaces/Notifications.tsx';
import { props } from './inbox-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

async function key(target: Element, name: string): Promise<void> {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

// Sol OW-112.3 correctness, retitled by what it proves; its body is Sol's.
it('notification arrow navigation moves focus with the selected tab', async () => {
  view = await mount(<NotificationsPanel {...props()} />);
  const tabs = view.all('[role="tab"]');
  const owed = tabs[0];
  const info = tabs[1];
  if (!(owed instanceof HTMLElement) || !(info instanceof HTMLElement))
    throw new Error('Tabs absent');
  owed.focus();
  await key(owed, 'ArrowRight');
  expect(info.getAttribute('aria-selected')).toBe('true');
  expect(info.tabIndex).toBe(0);
  expect(document.activeElement, 'Focus is stranded on the unselected tab with tabindex -1').toBe(
    info,
  );
});

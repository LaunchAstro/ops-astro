// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { PersonMenu } from '../../packages/ui/src/surfaces/PersonMenu.tsx';
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

// Sol OW-112.1 criterion 5, retitled by what it proves; its body is Sol's.
it('a parent refresh preserves the focused Sign out action', async () => {
  const menuProps = {
    name: 'Mia Hart',
    email: 'mia@example.test',
    settingsHref: '/settings',
    onSettings: () => {},
    onSignOut: () => {},
  };
  view = await mount(<PersonMenu {...menuProps} />);
  await view.click('.who__trigger');
  const settings = view.find('a[role="menuitem"]');
  const signOut = view.find('button[role="menuitem"]');
  if (settings === null || signOut === null) throw new Error('Menu did not open');
  await key(settings, 'ArrowDown');
  expect(document.activeElement).toBe(signOut);
  // The shell can rerender when its asynchronous count or person read arrives.
  // No menu prop, user gesture or session changed.
  await view.render(<PersonMenu {...menuProps} />);
  expect(document.activeElement, 'Refresh moved focus from Sign out to Your settings').toBe(
    signOut,
  );
});

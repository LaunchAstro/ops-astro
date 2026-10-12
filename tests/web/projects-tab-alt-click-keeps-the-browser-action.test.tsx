// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Projects tab is a link: a plain press switches the tab in place, and a
// press with any modifier (Meta, Control, Shift or Alt) is left to the
// browser's own link action.

import { act } from 'react';
import { expect, it } from 'vitest';
import { ProjectsTabs } from '../../apps/web/src/screens/projects/ProjectsTabs.tsx';
import { TABS } from '../../apps/web/src/screens/projects/tab-address.ts';
import { mount } from '../surfaces/mount.tsx';

it.each(['altKey', 'metaKey', 'ctrlKey', 'shiftKey'] as const)(
  'a press on a tab with %s held is left to the browser and selects nothing',
  async (modifier) => {
    const selected: string[] = [];
    const view = await mount(
      <ProjectsTabs
        label="Projects"
        name="projects"
        tabs={TABS}
        selected="board"
        onSelect={(id) => selected.push(id)}
      />,
    );
    const tab = view.find('[role="tab"]:nth-child(2)')!;
    const press = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      [modifier]: true,
    });
    await act(() => {
      tab.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(false);
    expect(selected).toEqual([]);
    await view.unmount();
  },
);

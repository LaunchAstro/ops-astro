// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's editor opens from the shell toolbar, inside the chrome, so
// it stacks no higher than the chrome does. Beside the page the floating dock
// sits above the chrome, and would cover the editor's right-hand controls:
// the open editor lifts the chrome over the dock, as an open menu does.
//
// jsdom lays nothing out, so this reads the shipped cascade: the desktop
// block of each sheet is taken as the window's, and the stacking the
// cascade gives the chrome and the dock is compared.

import { readFileSync } from 'node:fs';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { dockOf } from './dock-props.ts';
import { mount } from './mount.tsx';

const DESKTOP = '@media not all and (max-width: 900px)';

/** The shipped sheets, their desktop block applied: jsdom applies only `screen` media. */
const SHEETS = ['3-shell.css', '3-dock.css', '5-task.css']
  .map((sheet) => readFileSync(`packages/ui/src/styles/${sheet}`, 'utf8'))
  .join('\n')
  .replaceAll(DESKTOP, '@media screen');

const stack = (element: Element | null): number => {
  if (element === null) throw new Error('nothing to stack');
  return Number(getComputedStyle(element).zIndex);
};

describe('the task editor opened from the shell toolbar', () => {
  it('sits above the floating dock while open, and the chrome stays below it while closed', async () => {
    expect(SHEETS).toContain('@media screen');
    const style = document.createElement('style');
    style.textContent = SHEETS;
    document.head.append(style);
    try {
      const page = await mount(
        <Shell
          face="agency"
          build={null}
          rail={[]}
          here="/task/T-1"
          title="Task"
          dock={{ ...dockOf([]), layout: { mode: 'floating', panelWidth: 550 } }}
        >
          {null}
        </Shell>,
      );
      // The editor as the task page portals it into the toolbar.
      const editor = document.createElement('details');
      editor.className = 'task-controls';
      editor.innerHTML =
        '<summary class="dpanel__btn" aria-label="Edit task details"></summary>' +
        '<div class="task-controls__body"></div>';
      (page.find('.topbar__bar') as HTMLElement).append(editor);
      const chrome = page.find('.chrome');
      const dock = stack(page.find('.dock'));

      expect(stack(chrome)).toBeLessThan(dock);
      await act(() => {
        editor.open = true;
      });
      expect(stack(chrome)).toBeGreaterThan(dock);
    } finally {
      style.remove();
    }
  });
});

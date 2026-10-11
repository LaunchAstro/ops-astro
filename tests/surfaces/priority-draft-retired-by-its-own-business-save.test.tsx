// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { mount } from './mount.tsx';
import { tick } from './settings-four-eyes-world.tsx';
import {
  choosePriority,
  priorityInput,
  priorityScreen,
  prioritySettingsWorld,
  priorityWrites,
} from './priority-settings-world.tsx';

it('equal save revisions in different businesses still retire the new owner draft', async () => {
  window.sessionStorage.clear();
  const alpha = prioritySettingsWorld('alpha');
  const beta = prioritySettingsWorld('beta');
  beta.value = ['retention'];
  const page = await mount(priorityScreen(alpha));
  try {
    await tick();
    await choosePriority(page, 'sales');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(alpha.revision).toBe(8);
    await page.render(priorityScreen(beta, 'beta:ada:0'));
    await tick();
    expect(priorityInput(page, 'retention').checked).toBe(true);
    expect(priorityInput(page, 'sales').checked).toBe(false);
    await choosePriority(page, 'sales');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(beta.revision).toBe(8);
    expect(priorityWrites(beta)[0]?.body).toMatchObject({
      value: ['sales', 'retention'],
      expectedRevision: 7,
    });
    // Another administrator changes beta; a sign-off save triggers the real reread.
    beta.value = ['advocacy'];
    beta.revision = 9;
    await page.click('[data-settings="save-sign-off"]');
    await tick();
    expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Advocacy');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(beta)[1]?.body).toMatchObject({
      value: ['advocacy'],
      expectedRevision: 9,
    });
    expect(priorityInput(page, 'advocacy').checked).toBe(true);
    expect(priorityInput(page, 'sales').checked).toBe(false);
  } finally {
    await page.unmount();
  }
});

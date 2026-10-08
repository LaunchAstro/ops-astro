// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TaskPanel, type PanelOpening } from '../../apps/web/src/screens/task/Panel.tsx';
import { serving } from './panel-fields-support.tsx';
import { tick } from './task-page-stub.tsx';
import { mount } from '../surfaces/mount.tsx';

it('the board subtask door focuses the real add box, returns from Agent, and does not steal focus on a normal render', async () => {
  const { client } = serving();
  let opening: PanelOpening = { taskKey: 'T-1', door: 'add-first', tab: null };
  const element = () => (
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={opening}
      onChanged={() => {}}
      onClose={() => {}}
    />
  );
  const view = await mount(element());
  await tick();
  expect(document.activeElement).toBe(view.find('[data-step-add]'));
  await view.click('#panel-perspective-tab-agent');
  expect(view.find('#panel-perspective-tab-agent')?.getAttribute('aria-selected')).toBe('true');
  opening = { ...opening };
  await view.render(element());
  expect(view.find('#panel-perspective-tab-team')?.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(view.find('[data-step-add]'));
  const title = view.find('[data-panel-title] button');
  if (!(title instanceof HTMLElement)) throw new Error('Missing real title');
  title.focus();
  await view.render(element());
  expect(document.activeElement).toBe(title);
});

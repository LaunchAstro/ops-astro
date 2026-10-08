// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { encodeBoardAddress } from '../../apps/web/src/screens/projects/scoped-board.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { tick } from './work-log-stand-in.tsx';
import {
  boardA,
  scopedPerson,
  scopedClient,
  panel,
  destinationServer,
} from './projects-board-destination-support.tsx';
const custodyAddress = encodeBoardAddress({
  kind: 'aggregate',
  person: scopedPerson,
  client: scopedClient,
  filters: [],
  focus: null,
});
function retainedEditor(view: Mounted, boardNode: Element | null, editor: Element | null): void {
  expect(view.find('[data-board]')).toBe(boardNode);
  expect(view.find('.cbd__rename')).toBe(editor);
  expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe('Unsent edit');
  expect(view.host.querySelector<HTMLInputElement>('[data-board-search]')?.value).toBe('work');
  expect(view.find('th[data-key="due"]')?.getAttribute('aria-sort')).toBe('ascending');
  expect(document.activeElement).toBe(editor);
}
it('a held authority refresh withdraws private DOM and restores the same board editor query sort and focus', async () => {
  const api = destinationServer();
  const address = custodyAddress;
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  await view.type('[data-board-search]', 'work');
  await view.click('[data-key="due"] button');
  await act(() => {
    view.find('.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await view.type('.cbd__rename', 'Unsent edit');
  const boardNode = view.find('[data-board]');
  const editor = view.find('.cbd__rename');
  expect(document.activeElement).toBe(editor);
  api.holdVocabulary();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Scoped work');
  expect(view.text()).not.toContain('Current teammate');
  expect(view.text()).not.toContain('Current client');
  expect(view.find('[data-board-waiting-count]')).toBeNull();
  await act(async () => {
    api.releaseVocabulary();
    await Promise.resolve();
  });
  await tick();
  retainedEditor(view, boardNode, editor);
  expect(api.mutations).toEqual([]);
  api.holdVocabulary();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  api.revoke();
  await act(async () => {
    api.releaseVocabulary();
    await Promise.resolve();
  });
  await tick();
  expect(view.find('.cbd__rename')).toBeNull();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Current client');
});
it.each(['own', 'client', 'selected', 'unboarded'] as const)(
  'optional denied people vocabulary preserves admitted %s rows and the same unsent editor',
  async (kind) => {
    const api = destinationServer();
    const address = encodeBoardAddress({
      ...(kind === 'selected'
        ? { kind, boardId: boardA }
        : kind === 'unboarded'
          ? { kind }
          : { kind: 'aggregate' as const }),
      ...(kind === 'own' ? { own: true } : kind === 'client' ? { client: scopedClient } : {}),
      filters: [{ kind: 'words', value: 'work' }],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    const count = kind === 'own' || kind === 'client' ? 3 : 1;
    expect(view.all('[data-row]')).toHaveLength(count);
    await act(() => {
      view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await view.type('.cbd__rename', 'Still permitted unsent edit');
    const editor = view.find('.cbd__rename');
    api.denyPeople();
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.all('[data-row]')).toHaveLength(count);
    expect(view.find('.cbd__rename')).toBe(editor);
    expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe(
      'Still permitted unsent edit',
    );
    expect(view.find('[data-outcome="denied"]')).toBeNull();
    expect(view.find('button[aria-label^="Change the assignee"]')).toBeNull();
    await view.render(panel(api.client, address + '&q=work'));
    expect(view.all('[data-row]')).toHaveLength(count);
    expect(api.mutations).toEqual([]);
    await view.unmount();
    const cold = await mount(panel(api.client, address));
    await tick();
    await tick();
    expect(cold.all('[data-row]')).toHaveLength(count);
    expect(cold.find('button[aria-label^="Change the assignee"]')).toBeNull();
  },
);
it('an explicit person refusal withdraws the admitted board and clears unsent editor custody', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    filters: [],
    focus: null,
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  await act(() => {
    view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await view.type('.cbd__rename', 'Must discard on actual refusal');
  const editor = view.find('.cbd__rename');
  api.denyPeople();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  api.denyPeople(false);
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(3);
  expect(view.find('.cbd__rename')).toBeNull();
  expect(editor?.isConnected).toBe(false);
  expect(api.mutations).toEqual([]);
});

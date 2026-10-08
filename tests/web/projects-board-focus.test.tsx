// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { encodeBoardAddress } from '../../apps/web/src/screens/projects/scoped-board.ts';
import { mount } from '../surfaces/mount.tsx';
import { tick } from './work-log-stand-in.tsx';
import { scopedPerson, panel, destinationServer } from './projects-board-destination-support.tsx';
it('an unknown focused comment key is never named by the admitted board reading', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    filters: [],
    focus: 'Private-fabricated-key',
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Private-fabricated-key');
});
it('an admitted target clears ordinary filters focuses its canonical task link and scrolls its row', async () => {
  const api = destinationServer();
  const scroll = vi.fn();
  vi.stubGlobal('HTMLElement', HTMLElement);
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const address =
      encodeBoardAddress({
        kind: 'aggregate',
        person: scopedPerson,
        filters: [],
        focus: null,
        target: 'Scope-3',
      }) + '&q=absent&f=mine&mode=review';
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    const row = view.find(`[data-row="${api.tasks[2]!.id}"]`);
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row?.querySelector('a.cbd__nm'));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(view.host.querySelector<HTMLInputElement>('[data-board-search]')?.value).toBe('');
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
    vi.unstubAllGlobals();
  }
});
it('an out-of-scope target keeps ordinary search and cannot reveal a task', async () => {
  const api = destinationServer();
  api.tasks[2]!.assignee.personId = '99999999-9999-4999-8999-999999999999';
  const address =
    encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      filters: [],
      focus: null,
      target: 'Scope-3',
    }) + '&q=absent';
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.find('.cbd__filters')?.textContent).toContain('absent');
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Scoped work 3');
});

it('a target admitted after the first draw clears ordinary obscuring filters and focuses its existing row', async () => {
  const api = destinationServer();
  api.tasks[2]!.assignee.personId = '99999999-9999-4999-8999-999999999999';
  const address =
    encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      filters: [],
      focus: null,
      target: 'Scope-3',
    }) + '&q=absent';
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  api.tasks[2]!.assignee.personId = scopedPerson;
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  const target = view
    .all('[data-row]')
    .find((row) => (row instanceof HTMLElement ? row.dataset['row'] : null) === api.tasks[2]!.id);
  expect(target).toBeDefined();
  expect(document.activeElement).toBe(target?.querySelector('a.cbd__nm'));
});

it.each(['initial', 'late'] as const)(
  'a target %s under Work log waits for the visible Board before focus and scroll',
  async (arrival) => {
    const api = destinationServer();
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      if (arrival === 'late') api.holdNext();
      const address = encodeBoardAddress({
        kind: 'aggregate',
        person: scopedPerson,
        filters: [],
        focus: null,
        target: 'Scope-3',
      });
      const view = await mount(panel(api.client, address + '#worklog'));
      await tick();
      await tick();
      if (arrival === 'late') {
        await act(async () => {
          api.release();
          await Promise.resolve();
        });
        await tick();
      }
      expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
      expect(scroll).not.toHaveBeenCalled();
      await act(() => {
        (view.find('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.focus();
      });
      await view.click('[role="tab"]:nth-child(1)');
      await tick();
      const row = view.find(`[data-row="${api.tasks[2]!.id}"]`);
      expect(document.activeElement).toBe(row?.querySelector('a.cbd__nm'));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      HTMLElement.prototype.scrollIntoView = previous;
    }
  },
);

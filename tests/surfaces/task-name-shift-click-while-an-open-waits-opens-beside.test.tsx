// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ProjectName } from '../../packages/ui/src/surfaces/ProjectName.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { mount } from './mount.tsx';

const row: ProjectRow = {
  id: 'sol-slow-double-click',
  key: 'OPS-1',
  name: 'Private task',
  rank: { number: null, calc: '' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 1,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
};

it('Shift-click during a pending plain click opens beside instead of renaming', async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const view = await mount(
    <ProjectName row={row} href="/tasks/OPS-1" actions={{ onOpen, onRename: vi.fn() }} />,
  );
  try {
    const link = view.find('.cbd__nm');
    if (link === null) throw new Error('missing name link');
    await act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(() => {
      link.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          shiftKey: true,
        }),
      );
    });
    expect(view.find('input.cbd__rename')).toBeNull();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row, true);
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});

it('a Shift second click the browser counts as a double-click opens beside and never renames', async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const view = await mount(
    <ProjectName row={row} href="/tasks/OPS-1" actions={{ onOpen, onRename: vi.fn() }} />,
  );
  try {
    const link = view.find('.cbd__nm');
    if (link === null) throw new Error('missing name link');
    await act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(() => {
      const shifted = { bubbles: true, cancelable: true, detail: 2, shiftKey: true };
      link.dispatchEvent(new MouseEvent('click', shifted));
      link.dispatchEvent(new MouseEvent('dblclick', shifted));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(view.find('input.cbd__rename')).toBeNull();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row, true);
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});

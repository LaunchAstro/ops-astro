// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// A click inside an open cell editor that lands on the open menu's face
// (`.sel__btn`, the span that covers the cell while it is edited) belongs to
// the editor, so the row's blank-cell activation leaves the task panel shut.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow, RowActions } from '../../packages/ui/src/board/projects.ts';
import { mount } from './mount.tsx';

const row: ProjectRow = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'T-1',
  name: 'A task',
  rank: { number: 3, calc: '' },
  starred: false,
  client: null,
  assignee: null,
  due: '2026-10-20',
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

it('clicking an open cell editor does not open the task panel', async () => {
  const opened = vi.fn();
  const actions: RowActions = { onOpen: opened, onStage: vi.fn() };
  const view = await mount(
    <ProjectsBoard
      rows={[row]}
      withheld={0}
      stages={['Brief', 'Build']}
      href={() => '/task/T-1'}
      width={1400}
      viewport={1480}
      actions={actions}
    />,
  );
  await view.click('tr[data-row] td[data-key="stage"] .cbd__edb');
  const face = view.find('tr[data-row] td[data-key="stage"] .cbd__ed .sel__btn');
  expect(face).not.toBeNull();
  await act(() => {
    face?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  expect(view.find('tr[data-row] td[data-key="stage"] [role="listbox"]')).not.toBeNull();
  expect(opened).not.toHaveBeenCalled();
});

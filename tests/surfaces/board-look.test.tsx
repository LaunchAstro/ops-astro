// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// B2 and B3 (UI-POLISH): the Projects board and the inbox above it draw the
// mockup's parts from the kit. The look itself is held by the look probes
// (`tests/visual/look/board.ts`); this holds the markup those probes name.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Board, type BoardRow } from '../../packages/ui/src/index.ts';
import { dayOf } from '../../apps/web/src/screens/Projects.tsx';

const row = (over: Partial<BoardRow> & Pick<BoardRow, 'id'>): BoardRow => ({
  rank: null,
  name: 'Renewal pack',
  client: null,
  assignee: 'Nathan Mulligan',
  dueLabel: '7 Oct',
  due: 'later',
  stage: null,
  state: { word: 'Active', tone: 'run', reference: 'new_behaviour' },
  estimate: null,
  actual: null,
  group: 'Active',
  href: '/task/T-6',
  ...over,
});

const board = (rows: readonly BoardRow[], groups: readonly string[]): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <Board rows={rows} groups={groups} filters={[{ kind: 'board', label: 'none' }]} />,
  );
  return host;
};

describe('B2 the Projects board draws the mockup parts', () => {
  it('names each group heading by its group, so the first and the later ones can be told apart', () => {
    const host = board(
      [row({ id: 'a' }), row({ id: 'b', group: 'On hold' })],
      ['Active', 'On hold'],
    );
    const heads = [...host.querySelectorAll<HTMLElement>('tr.cbd__grp')];
    expect(heads.map((head) => head.dataset['grp'])).toEqual(['Active', 'On hold']);
  });

  it('draws the assignee as the kit avatar beside the name, and the state as the cell chip', () => {
    const host = board([row({ id: 'a' })], ['Active']);
    const avatar = host.querySelector('tr[data-taskrow] .av.av--person');
    expect(avatar?.textContent).toBe('NM');
    expect(avatar?.nextElementSibling?.textContent).toBe('Nathan Mulligan');
    expect(host.querySelector('tr[data-taskrow] .cbd__chip .spill')?.textContent).toBe('Active');
  });

  it('keeps a dash, in the rank look, where the row has no rank yet', () => {
    const host = board([row({ id: 'a' })], ['Active']);
    expect(host.querySelector('tr[data-taskrow] td:first-child .cbd__rank')?.textContent).toBe('—');
  });

  it('hides a column with its `col`, so the others take its share', () => {
    const host = board([row({ id: 'a' })], ['Active']);
    const hidden = [...host.querySelectorAll('col[data-hide-below]')].length;
    expect(hidden).toBe(host.querySelectorAll('th[data-hide-below]').length);
    expect(hidden).toBeGreaterThan(0);
  });

  it('closes with the reading line, the count of tasks it holds', () => {
    const host = board([row({ id: 'a' }), row({ id: 'b' })], ['Active']);
    expect(host.querySelector('.cbd__read')?.textContent).toBe('2 tasks');
  });

  it('writes a due day as the mockup does: day and short month, no year', () => {
    expect(dayOf('2026-09-30T00:00:00.000Z')).toBe('30 Sep');
    expect(dayOf('2026-10-07')).toBe('7 Oct');
  });
});

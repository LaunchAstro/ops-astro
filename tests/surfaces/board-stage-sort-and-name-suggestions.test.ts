// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { projectColumns, type ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { projectFacets } from '../../packages/ui/src/board/project-facets.ts';
import { nextSort, sortRows } from '../../packages/ui/src/board/sort.ts';
import { suggest } from '../../packages/ui/src/board/typeahead.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const row = (id: string, stage: string | null, name = id): ProjectRow => ({
  id,
  key: id,
  name,
  stage,
  rank: { number: null, calc: '' },
  starred: false,
  client: 'Acme Advocacy',
  assignee: null,
  due: null,
  completed: false,
  status: 'To do',
  statusPosition: null,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
});

// Sol OW-102.1 criterion correctness, retitled by what it proves; its body is Sol's.
it('reversed Stage keeps unknown stages after the vocabulary', () => {
  const rows = [
    row('brief', 'Brief'),
    row('custom', 'Custom'),
    row('launch', 'Launch'),
    row('blank', null),
  ];
  const columns = projectColumns({ stages: ['Brief', 'Launch'] });
  const column = columns.find((one) => one.key === 'stage');
  if (column === undefined) throw new Error('Stage column missing');
  const first = nextSort(null, column);
  expect(sortRows(rows, first, columns).map((one) => one.id)).toEqual([
    'brief',
    'launch',
    'custom',
    'blank',
  ]);
  const reversed = nextSort(first, column);
  expect(sortRows(rows, reversed, columns).map((one) => one.id)).toEqual([
    'launch',
    'brief',
    'custom',
    'blank',
  ]);
});

// Sol OW-102.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('a task named like its client remains a Name suggestion', () => {
  const rows = [row('task-1', null, 'Acme Advocacy')];
  const facets = projectFacets(rows, new Date('2026-10-04T12:00:00Z'));
  const groups = suggest({
    q: 'ac',
    facets,
    names: rows.map((one) => one.name),
    noun: 'task',
    have: { ids: [], text: [] },
  });
  expect(groups.find((one) => one.label === 'Clients')?.items).toHaveLength(1);
  expect(groups.find((one) => one.label === 'Tasks')?.items).toEqual([
    { kind: 'Name', label: 'Acme Advocacy', text: 'acme advocacy' },
  ]);
});

// Sol OW-102.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('taking a multiword Name stops suggesting the active words again', () => {
  const names = ['Launch brief'];
  const context: BoardContext<string> = { columns: [], facets: [], presets: [], modes: [] };
  const before = initialMachine();
  const offered = suggest({
    q: 'la',
    names,
    noun: 'task',
    facets: context.facets,
    have: before.view,
  });
  const item = offered[0]?.items[0];
  if (item?.text === undefined) throw new Error('Name suggestion missing');
  const after = reduceBoard(before, { type: 'phrase', text: item.text }, context);
  expect(after.view.text).toEqual(['launch', 'brief']);
  expect(
    suggest({ q: 'la', names, noun: 'task', facets: context.facets, have: after.view }),
  ).toEqual([]);
});

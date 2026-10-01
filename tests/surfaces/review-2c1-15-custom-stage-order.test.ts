// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-15, red proof: a stage outside the board's vocabulary is meant
// to sort after it (projects.ts `stageOrder`), but its key is '~'-prefixed and
// `sortRows` compares strings with localeCompare, under which '~' collates
// before the digits of the in-vocabulary keys, so the custom stage sorts
// first. Fixed when a 'Custom' stage sorts after Brief, Build and Launch.
// Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { projectColumns, type ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { nextSort, sortRows } from '../../packages/ui/src/board/sort.ts';

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: `TSK-${id}`,
  name: `Task ${id}`,
  rank: { number: null, calc: 'not ranked: missing ease' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'To do',
  statusPosition: null,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

const columns = projectColumns({ stages: ['Brief', 'Build', 'Launch'] });
const specOf = (key: string) => {
  const spec = columns.find((column) => column.key === key);
  if (spec === undefined) throw new Error(`no ${key} column`);
  return spec;
};
const order = (rows: readonly ProjectRow[], key: string): readonly string[] =>
  sortRows(rows, nextSort(null, specOf(key)), columns).map((each) => each.id);

describe('REVIEW-2C1-15 a stage outside the vocabulary sorts after it', () => {
  it('REVIEW-2C1-15: stages in stage order put an out-of-vocabulary Custom stage last, not first', () => {
    const rows = [
      row('b', { name: 'Beta', stage: 'Launch' }),
      row('x', { name: 'Extra', stage: 'Custom' }),
      row('a', { name: 'alpha', stage: 'Brief' }),
      row('c', { name: 'Gamma', stage: 'Build' }),
    ];
    expect(order(rows, 'stage')).toStrictEqual(['a', 'c', 'b', 'x']);
  });
});

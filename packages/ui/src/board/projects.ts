// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's nine columns and the words their cells draw (MP-5-8,
// BOARDS P-20 to P-28, P-36). Pure: the Projects screen maps its read onto
// `ProjectRow` and hands these columns to the board machine, which owns the
// widths, the sort cycle and the tight heads. There is no State column: the
// status is the group banner (R72). Every value is read from stored records
// or derived at read; nothing here is typed or stored.

import type { ColumnSpec } from './types.ts';
import type { ProjectRow } from './project-row.ts';
import { burnRatio, pad, waiting } from './project-words.ts';

export {
  burnOf,
  commentBadge,
  dueWords,
  estimateWords,
  rankCell,
  timeWords,
  tokenWords,
  type Burn,
} from './project-words.ts';

export type { Actual, Estimate, ProjectRow } from './project-row.ts';

/** Token rows sort after every time row (P-27). */
const TOKENS_AFTER = 1e12;
/** The starred tier sits above every ranked row (P-20). */
const STARRED_FIRST = -1e9;

/** The work order (P-20): the reader's starred rows, then ranked rows by #N, unranked last. */
const workOrder = (row: ProjectRow): number | null =>
  row.starred ? STARRED_FIRST + (row.rank.number ?? 0) : row.rank.number;

const shortName = (row: ProjectRow): string | null =>
  row.assignee === null ? null : (row.assignee.name.split(/\s+/u)[0] ?? row.assignee.name);

const estimateOrder = (row: ProjectRow): number | null =>
  row.estimate === null
    ? null
    : row.estimate.kind === 'time'
      ? row.estimate.minutes
      : TOKENS_AFTER + row.estimate.tokens;

function stageOrder(stages: readonly string[]): (row: ProjectRow) => string | number | null {
  return (row) => {
    if (row.stage === null) return null;
    const at = stages.indexOf(row.stage);
    // A stage outside the vocabulary sorts after it, by its words.
    return at === -1 ? `~${row.stage}` : `${pad(at).padStart(4, '0')}`;
  };
}

type Declared = Omit<ColumnSpec<ProjectRow>, 'sortValue'>;

/** The columns as the mockup declares them (P-20 to P-28), in its order. */
const DECLARED: readonly Declared[] = [
  {
    key: 'rank',
    label: 'Rank — the order to work in, highest leverage first',
    share: 2,
    min: 44,
    labelWidth: 0,
    iconOnly: true,
    icon: 'rank',
    align: 'center',
    firstDir: 'asc',
  },
  {
    key: 'name',
    label: 'Task name',
    share: 28.5,
    min: 180,
    labelWidth: 126,
    icon: 'list-check',
    align: 'start',
  },
  {
    key: 'comments',
    label: 'Client comments',
    share: 2,
    min: 44,
    labelWidth: 0,
    iconOnly: true,
    icon: 'comment',
    align: 'center',
    firstDir: 'desc',
  },
  {
    key: 'client',
    label: 'Client',
    share: 13.5,
    min: 110,
    labelWidth: 104,
    icon: 'building',
    align: 'start',
  },
  {
    key: 'assignee',
    label: 'Assignee',
    share: 11,
    min: 52,
    labelWidth: 118,
    icon: 'person',
    align: 'start',
  },
  {
    key: 'due',
    label: 'Due date',
    share: 12,
    min: 118,
    labelWidth: 118,
    icon: 'calendar',
    align: 'start',
    firstDir: 'asc',
  },
  {
    key: 'stage',
    label: 'Stage',
    share: 8.45,
    min: 84,
    labelWidth: 96,
    hideBelow: 900,
    icon: 'route',
    align: 'start',
  },
  {
    key: 'estimate',
    label: 'Estimates',
    share: 2,
    min: 48,
    labelWidth: 126,
    hideBelow: 1280,
    icon: 'hourglass',
    align: 'start',
    firstDir: 'asc',
  },
  {
    key: 'actual',
    label: 'Actual',
    share: 9.5,
    min: 104,
    labelWidth: 104,
    hideBelow: 1280,
    icon: 'stopwatch',
    align: 'start',
    firstDir: 'desc',
  },
];

function columnsFor(stages: readonly string[]): readonly ColumnSpec<ProjectRow>[] {
  const sortValues: Readonly<Record<string, (row: ProjectRow) => string | number | null>> = {
    rank: workOrder,
    name: (row) => row.name,
    comments: (row) => (waiting(row) === 0 ? null : waiting(row)),
    client: (row) => row.client,
    assignee: shortName,
    due: (row) => (row.due === null ? null : row.due.slice(0, 10)),
    stage: stageOrder(stages),
    estimate: estimateOrder,
    actual: burnRatio,
  };
  return DECLARED.map((column): ColumnSpec<ProjectRow> => {
    const sortValue = sortValues[column.key];
    return sortValue === undefined ? column : Object.assign({}, column, { sortValue });
  });
}

/** The nine columns with no stage vocabulary: stages then sort by their words. */
export const PROJECT_COLUMNS: readonly ColumnSpec<ProjectRow>[] = columnsFor([]);

/**
 * The columns this reading draws. The Client column is dropped when exactly
 * one client filter is on, or when every row shown is the one client's
 * (P-23): a column that says the same name on every row says nothing.
 */
export function projectColumns(options: {
  readonly stages: readonly string[];
  readonly rows?: readonly ProjectRow[];
  readonly clientFilters?: number;
}): readonly ColumnSpec<ProjectRow>[] {
  const all = columnsFor(options.stages);
  const rows = options.rows;
  const oneClient =
    options.clientFilters === 1 ||
    (rows !== undefined && new Set(rows.map((row) => row.client)).size <= 1);
  return oneClient ? all.filter((column) => column.key !== 'client') : all;
}

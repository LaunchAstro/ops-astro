// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's gallery fixture (U09): synthetic tasks, never a real
// client, drawn by the machine exactly as a board draws them. Each U09 owner
// check runs here until the Projects board takes the machine (MP-5-8, U25),
// where it runs again as written.

import type { ReactElement } from 'react';
import { BoardMachine, type BoardMachineProps } from '../surfaces/BoardMachine.tsx';
import type { ColumnSpec, Facet } from './types.ts';

export interface GalleryTask {
  readonly id: string;
  readonly name: string;
  readonly client: string | null;
  readonly category: string;
  readonly assignee: string | null;
  /** Days from today; negative is overdue. */
  readonly due: number | null;
  readonly minutes: number | null;
  readonly group: string;
  readonly waiting: boolean;
}

const task = (
  id: string,
  name: string,
  client: string | null,
  category: string,
  assignee: string | null,
  due: number | null,
  minutes: number | null,
  group: string,
  waiting = false,
): GalleryTask => ({ id, name, client, category, assignee, due, minutes, group, waiting });

export const GALLERY_TASKS: readonly GalleryTask[] = [
  task('g1', 'Logo refresh', 'Acme Advocacy', 'Branding', 'Ada Park', 2, 90, 'In progress'),
  task(
    'g2',
    'Landing page copy',
    'Acme Advocacy',
    'Content',
    'Mia Chen',
    -1,
    45,
    'In progress',
    true,
  ),
  task('g3', 'Monthly report', 'Beta Bakery', 'Reporting', 'Ada Park', 5, null, 'To do'),
  task('g4', 'Admin audit', null, 'Admin', null, null, null, 'To do'),
  task('g5', 'Search console fixes', 'Beta Bakery', 'SEO', 'Noah Reid', 0, 120, 'Review', true),
  task('g6', 'Brand guide', 'Cobalt Clinic', 'Branding', 'Mia Chen', 9, 30, 'To do'),
  task(
    'g7',
    'Booking form',
    'Cobalt Clinic',
    'Dev & Integrations',
    'Noah Reid',
    3,
    240,
    'In progress',
  ),
  task('g8', 'Ad copy variants', 'Acme Advocacy', 'Paid Ads', 'Ada Park', 1, 60, 'Review'),
];

export const GALLERY_GROUPS: readonly string[] = ['To do', 'In progress', 'Review'];

const dueWords = (due: number | null): string =>
  due === null
    ? '—'
    : due < 0
      ? `Overdue · ${String(-due)}d`
      : due === 0
        ? 'Today'
        : `In ${String(due)}d`;

export const GALLERY_COLUMNS: readonly ColumnSpec<GalleryTask>[] = [
  {
    key: 'name',
    label: 'Task name',
    share: 30,
    min: 140,
    labelWidth: 96,
    align: 'start',
    sortValue: (row) => row.name,
  },
  {
    key: 'client',
    label: 'Client',
    share: 16,
    min: 72,
    labelWidth: 64,
    align: 'start',
    icon: 'building',
    sortValue: (row) => row.client,
  },
  {
    key: 'assignee',
    label: 'Assignee',
    share: 14,
    min: 64,
    labelWidth: 84,
    align: 'start',
    icon: 'person',
    sortValue: (row) => row.assignee,
  },
  {
    key: 'due',
    label: 'Due date',
    share: 13,
    min: 64,
    labelWidth: 84,
    align: 'start',
    icon: 'calendar',
    sortValue: (row) => row.due,
  },
  {
    key: 'category',
    label: 'Category',
    share: 13,
    min: 72,
    labelWidth: 84,
    align: 'start',
    icon: 'tag',
    hideBelow: 900,
    sortValue: (row) => row.category,
  },
  {
    key: 'waiting',
    label: 'Client comments',
    share: 4,
    min: 36,
    labelWidth: 0,
    align: 'center',
    iconOnly: true,
    icon: 'comment',
    firstDir: 'desc',
    sortValue: (row) => (row.waiting ? 1 : 0),
  },
  {
    key: 'actual',
    label: 'Actual',
    share: 10,
    min: 56,
    labelWidth: 60,
    align: 'end',
    hideBelow: 1280,
    sortValue: (row) => row.minutes,
  },
];

const byField = (
  kind: string,
  values: readonly string[],
  of: (row: GalleryTask) => string | null,
): Facet<GalleryTask>[] =>
  values.map((value) => ({
    id: `${kind.toLowerCase()}:${value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}`,
    kind,
    label: value,
    words: value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word !== ''),
    test: (row: GalleryTask) => of(row) === value,
  }));

const distinct = (of: (row: GalleryTask) => string | null): readonly string[] =>
  [...new Set(GALLERY_TASKS.map(of))].filter((value): value is string => value !== null).toSorted();

export const GALLERY_FACETS: readonly Facet<GalleryTask>[] = [
  ...byField(
    'Client',
    distinct((row) => row.client),
    (row) => row.client,
  ),
  ...byField(
    'Category',
    distinct((row) => row.category),
    (row) => row.category,
  ),
  ...byField(
    'Assignee',
    distinct((row) => row.assignee),
    (row) => row.assignee,
  ),
  {
    id: 'due:overdue',
    kind: 'Due',
    label: 'Overdue',
    words: ['overdue', 'late'],
    test: (row) => (row.due ?? 1) < 0,
  },
  ...byField('Status', GALLERY_GROUPS, (row) => row.group),
];

const cell = (row: GalleryTask, key: string): string => {
  switch (key) {
    case 'name':
      return row.name;
    case 'client':
      return row.client ?? '—';
    case 'assignee':
      return row.assignee ?? 'Unassigned';
    case 'due':
      return dueWords(row.due);
    case 'category':
      return row.category;
    case 'waiting':
      return row.waiting ? '●' : '';
    case 'actual':
      return row.minutes === null
        ? '—'
        : `${String(Math.floor(row.minutes / 60))}h ${String(row.minutes % 60)}m`;
    default:
      return '';
  }
};

/** The fixture's props, so a test can vary one of them. */
export const GALLERY_BOARD: BoardMachineProps<GalleryTask> = {
  rows: GALLERY_TASKS,
  withheld: 2,
  columns: GALLERY_COLUMNS,
  facets: GALLERY_FACETS,
  presets: [
    { id: 'mine', label: 'Ada Park', facetIds: ['assignee:ada-park'] },
    { id: 'attention', label: 'Needs attention', facetIds: ['due:overdue'] },
  ],
  modes: [
    {
      id: 'review',
      label: 'Review',
      render: (rows) => (
        <ul className="cbdm__review" data-mode-surface="review">
          {rows
            .filter((row) => row.group === 'Review')
            .map((row) => (
              <li key={row.id}>{row.name}</li>
            ))}
        </ul>
      ),
    },
  ],
  groups: { order: GALLERY_GROUPS, of: (row) => row.group },
  rowKey: (row) => row.id,
  cell,
  hay: (row) => `${row.name} ${row.client ?? ''} ${row.assignee ?? ''}`,
  name: (row) => row.name,
  noun: 'task',
  empty: {
    title: 'No task matches that.',
    description: 'Drop a filter or Clear all to widen the list.',
  },
};

export function BoardGallery(props: Partial<BoardMachineProps<GalleryTask>>): ReactElement {
  return <BoardMachine {...GALLERY_BOARD} {...props} />;
}

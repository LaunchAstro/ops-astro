// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board (MP-5-8): the board machine handed the Projects rows,
// the nine columns and their cells. It opens on the work order, the arrow
// under Rank (P-20), and the rows it is handed are already in that order, so
// the sort's third press, the board's own order, is the work order too. The
// Client column drops when one client is shown (P-23). The rows gather under
// their statuses in the workflow's order, each banner with its waiting
// reasons (MP-5-11). The chip row carries the viewer's own chip (on at load
// unless `viewerOn` is false, as on a client's board), a chip per category in
// scope, and the Review mode with its live count (MP-5-12).

import { useMemo, useState, type ReactElement } from 'react';
import { BoardMachine } from './BoardMachine.tsx';
import { projectCell, type CellContext } from './ProjectCell.tsx';
import {
  groupReason,
  projectColumns,
  statusOrder,
  type ProjectRow,
  type RowActions,
} from '../board/projects.ts';
import { clientFiltersIn, projectFacets } from '../board/project-facets.ts';
import {
  openWithViewer,
  projectPresets,
  reviewBadge,
  REVIEW_MODE,
} from '../board/project-presets.ts';
import { sortRows } from '../board/sort.ts';

export interface ProjectsBoardProps {
  /** The rows the reader may read, as the board's read answered them. */
  readonly rows: readonly ProjectRow[];
  readonly withheld?: number;
  readonly changedAt?: string | null;
  /** The stage vocabulary, in its order; stages outside it sort after. */
  readonly stages: readonly string[];
  /** Where a row's record opens. */
  readonly href: (row: ProjectRow) => string;
  readonly address?: string;
  readonly onAddress?: (address: string) => void;
  readonly now?: Date;
  readonly width?: number;
  readonly viewport?: number;
  /** The signed-in person, whose own tasks the viewer preset narrows to. */
  readonly viewer?: string | null;
  /** The reader's owed count (INB-1), Review's count; the rows' own count when not given. */
  readonly owed?: number;
  /** Whether the viewer preset is on at load: agency-wide yes, a client's board no. */
  readonly viewerOn?: boolean;
  /** What a row can do (MP-5-9); the page owns the commands. */
  readonly actions?: RowActions;
}

const WORK_ORDER = { key: 'rank', dir: 'asc' } as const;

/** The address with the work order as its sort when it names none. */
function withWorkOrder(address: string): string {
  const params = new URLSearchParams(address.startsWith('?') ? address.slice(1) : address);
  if (!params.has('sort')) params.set('sort', `${WORK_ORDER.key}.${WORK_ORDER.dir}`);
  return params.toString();
}

const REVIEW_EMPTY = {
  title: 'Nothing is waiting for your decision.',
  description: 'Press Review again to go back to every task.',
};

/** The chip row's presets and the Review mode with its live count (MP-5-12). */
function useChips(rows: readonly ProjectRow[], viewer: string | null, now: Date, owed?: number) {
  const facets = useMemo(() => projectFacets(rows, now, viewer), [rows, now, viewer]);
  const presets = useMemo(() => projectPresets(rows, viewer), [rows, viewer]);
  const modes = useMemo(
    () => [{ ...REVIEW_MODE, badge: reviewBadge(rows, owed), empty: REVIEW_EMPTY }],
    [rows, owed],
  );
  return { facets, presets, modes };
}

/** The stage editor's choices: the vocabulary in its order, then stages in use outside it. */
function stageChoices(vocabulary: readonly string[], rows: readonly ProjectRow[]): string[] {
  const inUse = rows.flatMap((row) => (row.stage === null ? [] : [row.stage]));
  return [...new Set([...vocabulary, ...inUse])];
}

/** What every cell draws with: the clock, the links, the commands and the stage choices. */
function useCells(props: ProjectsBoardProps, now: Date): CellContext {
  const stages = useMemo(() => stageChoices(props.stages, props.rows), [props.stages, props.rows]);
  return {
    now,
    href: props.href,
    stages,
    ...(props.actions ? { actions: props.actions } : {}),
  };
}

export function ProjectsBoard(props: ProjectsBoardProps): ReactElement {
  const viewer = props.viewer ?? null;
  // The viewer preset is on at load agency-wide and off on a client's board (P-11).
  const [opening] = useState(() =>
    withWorkOrder(openWithViewer(props.address ?? '', props.viewerOn === false ? null : viewer)),
  );
  const [address, setAddress] = useState(opening);
  const now = useMemo(() => props.now ?? new Date(), [props.now]);
  const clientFilters = clientFiltersIn(address);
  const columns = useMemo(
    () => projectColumns({ stages: props.stages, rows: props.rows, clientFilters }),
    [props.stages, props.rows, clientFilters],
  );
  const rows = useMemo(
    () => sortRows(props.rows, WORK_ORDER, projectColumns({ stages: props.stages })),
    [props.rows, props.stages],
  );
  const { facets, presets, modes } = useChips(props.rows, viewer, now, props.owed);
  const cells = useCells(props, now);
  const statuses = useMemo(() => statusOrder(props.rows), [props.rows]);
  return (
    <BoardMachine<ProjectRow>
      rows={rows}
      withheld={props.withheld ?? 0}
      columns={columns}
      facets={facets}
      presets={presets}
      modes={modes}
      groups={{ order: statuses, of: (row) => row.status, reason: groupReason }}
      rowKey={(row) => row.id}
      cell={(row, key) => projectCell(row, key, cells)}
      hay={(row) => `${row.name} ${row.client ?? ''} ${row.assignee?.name ?? ''}`}
      name={(row) => row.name}
      noun="task"
      empty={{
        title: 'No task matches that.',
        description: 'Drop a filter or Clear all to widen the list.',
      }}
      address={opening}
      onAddress={(next) => {
        setAddress(next);
        props.onAddress?.(next);
      }}
      changedAt={props.changedAt ?? null}
      now={now}
      {...(props.width === undefined ? {} : { width: props.width })}
      {...(props.viewport === undefined ? {} : { viewport: props.viewport })}
    />
  );
}

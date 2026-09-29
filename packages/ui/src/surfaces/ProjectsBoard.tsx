// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board (MP-5-8): the board machine handed the Projects rows,
// the nine columns and their cells. It opens on the work order, the arrow
// under Rank (P-20), and the rows it is handed are already in that order, so
// the sort's third press, the board's own order, is the work order too. The
// Client column drops when one client is shown (P-23).

import { useMemo, useState, type ReactElement } from 'react';
import { BoardMachine } from './BoardMachine.tsx';
import { projectCell } from './ProjectCell.tsx';
import { projectColumns, type ProjectRow } from '../board/projects.ts';
import { clientFiltersIn, projectFacets } from '../board/project-facets.ts';
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
}

const WORK_ORDER = { key: 'rank', dir: 'asc' } as const;

/** The address with the work order as its sort when it names none. */
function withWorkOrder(address: string): string {
  const params = new URLSearchParams(address.startsWith('?') ? address.slice(1) : address);
  if (!params.has('sort')) params.set('sort', `${WORK_ORDER.key}.${WORK_ORDER.dir}`);
  return params.toString();
}

export function ProjectsBoard(props: ProjectsBoardProps): ReactElement {
  const [opening] = useState(() => withWorkOrder(props.address ?? ''));
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
  const facets = useMemo(() => projectFacets(props.rows, now), [props.rows, now]);
  const statuses = useMemo(() => [...new Set(rows.map((row) => row.status))], [rows]);
  return (
    <BoardMachine<ProjectRow>
      rows={rows}
      withheld={props.withheld ?? 0}
      columns={columns}
      facets={facets}
      groups={{ order: statuses, of: (row) => row.status }}
      rowKey={(row) => row.id}
      cell={(row, key) => projectCell(row, key, { now, href: props.href })}
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

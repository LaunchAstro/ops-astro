// SPDX-License-Identifier: AGPL-3.0-only
//
// Section 002 of Connections & signal (MP-14-7a, AG-C11 to AG-C20): the
// status facets, the sortable connector table and the fold. Facets, sort,
// expansion and the fold are view state (`fleet-view.ts`) and send nothing.
// Each row and its detail are `fleet-row.tsx`.

import type { ReactElement } from 'react';
import type { ConnectionView } from '../../../../../packages/core-wire/src/index.ts';
import { Detail, Row, STATUS_WORD } from './fleet-row.tsx';
import {
  PAGE,
  showMore,
  toggleOpen,
  visibleRows,
  withFacet,
  withSort,
  type Facet,
  type FleetView,
  type SortKey,
} from './fleet-view.ts';

const COLUMNS: readonly (readonly [SortKey, string])[] = [
  ['status', 'Status'],
  ['source', 'Source'],
  ['clients', 'Clients'],
  ['lastPass', 'Last pass'],
  ['freshness', 'Freshness'],
  ['quota', 'Quota burn'],
];

const FACETS: readonly Facet[] = ['all', 'active', 'degraded', 'broken'];

export interface FleetTableProps {
  readonly rows: readonly ConnectionView[];
  readonly counts: Readonly<Record<Facet, number>>;
  readonly view: FleetView;
  readonly setView: (view: FleetView) => void;
  readonly now: number;
  readonly repair: (row: ConnectionView) => void;
  readonly repairSaid: Readonly<Record<string, string>>;
}

type ViewProps = Pick<FleetTableProps, 'view' | 'setView'>;

function Facets(props: ViewProps & Pick<FleetTableProps, 'counts'>): ReactElement {
  const { view, setView } = props;
  return (
    <div className="connctrls">
      <div className="facets" role="group" aria-label="Filter connectors by status">
        {FACETS.map((facet) => (
          <button
            key={facet}
            type="button"
            className="facet"
            data-fleet-facet={facet}
            aria-pressed={view.facet === facet}
            onClick={() => {
              setView(withFacet(view, facet));
            }}
          >
            {facet === 'all' ? 'All' : STATUS_WORD[facet]} {props.counts[facet]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Header(props: ViewProps): ReactElement {
  const { view, setView } = props;
  const sorted = (key: SortKey): 'ascending' | 'descending' | 'none' => {
    if (view.sort.key !== key) return 'none';
    return view.sort.direction === 'asc' ? 'ascending' : 'descending';
  };
  return (
    <thead>
      <tr>
        {COLUMNS.map(([key, label]) => (
          <th key={key} aria-sort={sorted(key)}>
            <button
              type="button"
              data-fleet-sort={key}
              onClick={() => {
                setView(withSort(view, key));
              }}
            >
              {label}
              {{ ascending: ' ▲', descending: ' ▼', none: '' }[sorted(key)]}
            </button>
          </th>
        ))}
        <th aria-hidden="true" />
      </tr>
    </thead>
  );
}

function Fold(props: ViewProps & { readonly shown: number; readonly total: number }): ReactElement {
  const hidden = props.total - props.shown;
  return (
    <div className="connmore">
      <p className="pginfo" data-fleet-showing>
        Showing {props.shown} of {props.total} connectors
      </p>
      {hidden > 0 ? (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          data-fleet-more
          onClick={() => {
            props.setView(showMore(props.view));
          }}
        >
          Show {Math.min(hidden, PAGE)} more
        </button>
      ) : null}
    </div>
  );
}

export function FleetTable(props: FleetTableProps): ReactElement {
  const { view, setView, now } = props;
  const shown = visibleRows(props.rows, view, now);
  return (
    <>
      <Facets view={view} setView={setView} counts={props.counts} />
      <p className="approval__meta">Click a column heading to sort</p>
      <div className="card card--flush conn__scroll">
        <table className="conn">
          <Header view={view} setView={setView} />
          <tbody>
            {shown.rows.flatMap((row) => {
              const open = view.open.has(row.id);
              const toggle = (): void => {
                setView(toggleOpen(view, row.id));
              };
              const drawn = [<Row key={row.id} row={row} open={open} now={now} toggle={toggle} />];
              if (open) {
                drawn.push(
                  <Detail
                    key={`${row.id}-detail`}
                    row={row}
                    columns={COLUMNS.length + 1}
                    now={now}
                    repair={props.repair}
                    said={props.repairSaid[row.id]}
                  />,
                );
              }
              return drawn;
            })}
          </tbody>
        </table>
      </div>
      <Fold view={view} setView={setView} shown={shown.rows.length} total={shown.total} />
      <p className="legend">
        Syncing clean · Degraded, quota or throttle · Broken, data gap accruing · Freshness T-n =
        data is n days behind today
      </p>
    </>
  );
}

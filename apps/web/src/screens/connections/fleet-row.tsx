// SPDX-License-Identifier: AGPL-3.0-only
//
// One connector row of the fleet table and its detail (MP-14-7a, AG-C15 to
// AG-C18). The detail's clients, scope and custody come from the connection
// record as the fleet read returned it; custody is a reference, the
// credential's state and never any part of it.
//
// Sync now, Re-authorise and Test are drawn disabled with their reason: no
// connector can sync, re-authorise or test a source until the source's own
// connector exists (the phase 6 sources, MP-14-7b; the broker, AW-01). The
// one live control is Repair, on a broken connection, which records
// `connector repair started` (CS-14.12).

import type { ReactElement } from 'react';
import type { ConnectionView } from '../../../../../packages/core-wire/src/index.ts';
import { freshnessOf, isStuck } from './fleet-view.ts';

const UNTIL = 'Unavailable until the connector for this source exists (MP-14-7b, AW-01).';

export const STATUS_WORD: Readonly<Record<ConnectionView['status'], string>> = {
  active: 'Active',
  degraded: 'Degraded',
  broken: 'Broken',
};

function time(at: string | null): string {
  return at === null ? '—' : new Date(at).toLocaleString();
}

function Unavailable(props: { readonly action: string; readonly label: string }): ReactElement {
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost"
      data-action={props.action}
      disabled
      title={UNTIL}
    >
      {props.label}
    </button>
  );
}

function Clients(props: { readonly row: ConnectionView }): ReactElement {
  const { clients } = props.row;
  return (
    <div className="panel__block">
      <p>{clients.length === 0 ? 'None connected yet' : `${clients.length} clients connected`}</p>
      <ul className="chips">
        {clients.map((client) => (
          <li key={client.id} className="chip">
            {client.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Scope(props: { readonly row: ConnectionView }): ReactElement {
  const { row } = props;
  const executes = row.executeComponents.length > 0;
  return (
    <div className="panel__block">
      <p>Scope &amp; permissions</p>
      <p className="t-2">{row.scope === '' ? 'No scope recorded' : row.scope}</p>
      <ul>
        {row.readComponents.map((part) => (
          <li key={`read-${part}`}>
            {part} <span className="tag">read</span>
          </li>
        ))}
        {row.executeComponents.map((part) => (
          <li key={`execute-${part}`}>
            {part} <span className="tag">execute</span>
          </li>
        ))}
      </ul>
      <p className="vaultpill" data-custody={row.custody.state}>
        ■ Custody · credential {row.custody.state}{' '}
        <span className="tag">{executes ? 'read + execute' : 'read-only'}</span>
      </p>
    </div>
  );
}

function Actions(props: {
  readonly row: ConnectionView;
  readonly now: number;
  readonly repair: (row: ConnectionView) => void;
  readonly said: string | undefined;
}): ReactElement {
  const { row } = props;
  const broken = row.status === 'broken';
  return (
    <div className="panel__actions">
      {broken && row.repairStartedAt === null ? (
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-connection-repair={row.id}
          onClick={() => {
            props.repair(row);
          }}
        >
          Repair
        </button>
      ) : null}
      {row.repairStartedAt === null ? null : (
        <p role="status">
          Repair started {time(row.repairStartedAt)}. Re-authorising waits for approval.
        </p>
      )}
      {props.said === undefined ? null : <p role="alert">{props.said}</p>}
      {broken ? <Unavailable action="reauthorise" label="Re-authorise" /> : null}
      {isStuck(row, props.now) ? <Unavailable action="sync" label="Sync now" /> : null}
      <Unavailable action="test" label="Test" />
    </div>
  );
}

export function Detail(props: {
  readonly row: ConnectionView;
  readonly columns: number;
  readonly now: number;
  readonly repair: (row: ConnectionView) => void;
  readonly said: string | undefined;
}): ReactElement {
  return (
    <tr className="conn__detail" data-connection-detail={props.row.id}>
      <td colSpan={props.columns}>
        <div className="conn__panel">
          <Clients row={props.row} />
          <Scope row={props.row} />
          <Actions row={props.row} now={props.now} repair={props.repair} said={props.said} />
        </div>
      </td>
    </tr>
  );
}

export function Row(props: {
  readonly row: ConnectionView;
  readonly open: boolean;
  readonly now: number;
  readonly toggle: () => void;
}): ReactElement {
  const { row } = props;
  const fresh = freshnessOf(row, props.now);
  return (
    <tr
      className="conn__row"
      data-connection={row.id}
      data-status={row.status}
      aria-expanded={props.open}
      onClick={props.toggle}
    >
      <td>
        <span className={`dot dot--${row.status}`} /> {STATUS_WORD[row.status]}
      </td>
      <td>
        <strong>{row.label}</strong>
        <br />
        <span className="t-2">{row.authMethod}</span>
      </td>
      <td data-cell="clients">{row.clients.length}</td>
      <td className="mono">{time(row.lastAttemptAt)}</td>
      <td className={`mono is-${fresh.tone}`} data-tone={fresh.tone}>
        {fresh.daysBehind === null ? '—' : `T-${fresh.daysBehind}`}
      </td>
      <td className="t-2" title="Quota burn arrives with the phase 6 sources (MP-14-7b).">
        not connected
      </td>
      <td aria-hidden="true">›</td>
    </tr>
  );
}

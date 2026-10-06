// SPDX-License-Identifier: AGPL-3.0-only
//
// The tickets view (WF-4): every ticket on the map that passes the filters,
// each linking its own page, with what blocks it. Blocking is
// `task.set_blocking` on the blocked ticket, which takes the whole list: adding
// a blocker sends the list with it, removing one sends the list without it.
// The command refuses a blocker from another map, a cycle and a foreign id.

import { useState, type ReactElement } from 'react';
import type { MapView } from '../../../../../packages/core-wire/src/index.ts';
import { Section, ticketLink } from './ReadSections.tsx';
import { passes, type Filters, type Send } from './model.ts';

type Ticket = MapView['tickets'][number];

export function TicketsView(props: {
  readonly map: MapView;
  readonly filters: Filters;
  readonly busy: boolean;
  readonly send: Send;
}): ReactElement {
  const tickets = props.map.tickets;
  const shown = tickets.filter((ticket) => passes(props.filters, ticket));
  const name = (id: string) => {
    const found = tickets.find((ticket) => ticket.id === id);
    return found?.key ?? found?.title ?? id;
  };
  return (
    <Section name="tickets" label="Tickets">
      {shown.length === 0 ? <p>No ticket on this map passes the filters.</p> : null}
      <ul>
        {shown.map((ticket) => (
          <li key={ticket.id} data-ticket-row={ticket.id}>
            {ticketLink(ticket.key, `${ticket.key ?? ''} ${ticket.title ?? ''}`.trim())}{' '}
            <span className="sbact__meta">
              {ticket.type} · {ticket.state ?? 'no state'}
            </span>
            <Blockers ticket={ticket} name={name} busy={props.busy} send={props.send} />
            <BlockControl ticket={ticket} tickets={tickets} busy={props.busy} send={props.send} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Blockers(props: {
  readonly ticket: Ticket;
  readonly name: (id: string) => string;
  readonly busy: boolean;
  readonly send: Send;
}): ReactElement | null {
  const { ticket } = props;
  if (ticket.blockedBy.length === 0) return null;
  return (
    <span>
      {' '}
      Blocked by:{' '}
      {ticket.blockedBy.map((blocker) => (
        <span key={blocker} data-blocked-by={blocker}>
          {props.name(blocker)}{' '}
          <button
            className="btn"
            type="button"
            data-unblock={`${ticket.id}:${blocker}`}
            disabled={props.busy}
            onClick={() => {
              props.send('task.set_blocking', ticket.id, ticket.revision, {
                blockedBy: ticket.blockedBy.filter((one) => one !== blocker),
              });
            }}
          >
            Remove
          </button>{' '}
        </span>
      ))}
    </span>
  );
}

function BlockControl(props: {
  readonly ticket: Ticket;
  readonly tickets: readonly Ticket[];
  readonly busy: boolean;
  readonly send: Send;
}): ReactElement {
  const { ticket } = props;
  const [chosen, setChosen] = useState('');
  const others = props.tickets.filter(
    (one) => one.id !== ticket.id && !ticket.blockedBy.includes(one.id),
  );
  return (
    <span className="btnrow">
      <select
        className="input"
        name={`block-${ticket.id}`}
        aria-label={`Block ${ticket.key ?? ticket.id} by`}
        value={chosen}
        onChange={(event) => {
          setChosen(event.target.value);
        }}
      >
        <option value="">Blocked by…</option>
        {others.map((one) => (
          <option key={one.id} value={one.id}>
            {one.key ?? one.id} {one.title ?? ''}
          </option>
        ))}
      </select>
      <button
        className="btn"
        type="button"
        data-block={ticket.id}
        disabled={props.busy || chosen === ''}
        onClick={() => {
          props.send('task.set_blocking', ticket.id, ticket.revision, {
            blockedBy: [...ticket.blockedBy, chosen],
          });
        }}
      >
        Block
      </button>
    </span>
  );
}

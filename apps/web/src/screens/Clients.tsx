// SPDX-License-Identifier: AGPL-3.0-only
//
// THE CLIENTS PANEL (DOCK.md section 2; the dock's `clients`): the client book
// as a list kept beside any page, and at `/clients/` that list in full-page
// form until MP-8-5's CRM board takes the address.
//
// Client records (MP-10-1) are not built, so the book is made up
// (`data/clients-book.ts`), drawn under the design system's mock mark, and a
// line says so. The count counts the book it draws, never a second total, and
// a search that finds nothing says so in a sentence (D-6).
//
// A row carries only the doors this application serves. The one drawn is
// Projects: a link to the board that the dock's gesture law takes when the
// Projects panel is registered (plain solos, shift stacks) and the application
// follows as a link when it is not. It opens the whole board: the board has no
// client to filter by until client records exist. Not drawn, and why:
// - a row press walking to the client's record: the record is MP-10-1's;
// - Portal (`/clients/<slug>/`): no person holds a client grant before MP-10-1,
//   so every one lands on the refusal;
// - Docs: no Docs panel is registered;
// - the comment badge's door: no view narrows the board to a client's waiting
//   messages, so the count is drawn as a mark, not a control.
// The head's sync stamp and button are gone with live sync (LIVE-SYNC.md).

import { useState, type ReactElement } from 'react';
import { Count, Icon, MockRegion } from '@launchastro/ui';
import { MADE_UP_BOOK, type BookClient, type ClientBook } from '../data/clients-book.ts';
import { pathTo } from '../routes.ts';

const initials = (name: string): string =>
  name
    .replaceAll('&', ' ')
    .split(/\s+/u)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('');

/** The book's clients A to Z whose name or industry holds the query, whatever the case. */
function search(book: ClientBook, query: string): readonly BookClient[] {
  const wanted = query.trim().toLowerCase();
  return book.clients
    .filter(
      (client) =>
        wanted === '' ||
        client.name.toLowerCase().includes(wanted) ||
        client.industry.toLowerCase().includes(wanted),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** "3 of 8 clients · 21 open · 4 waiting on us"; the last clause only when something waits. */
function countLine(shown: readonly BookClient[], book: ClientBook): string {
  const open = shown.reduce((sum, client) => sum + client.open, 0);
  const waiting = shown.reduce((sum, client) => sum + client.waiting, 0);
  const line = `${String(shown.length)} of ${String(book.clients.length)} clients · ${String(open)} open`;
  return waiting > 0 ? `${line} · ${String(waiting)} waiting on us` : line;
}

function Row(props: { readonly client: BookClient }): ReactElement {
  const { client } = props;
  const board = pathTo('agency:projects-board');
  return (
    <li className="clbook__item">
      <div className="clbook__row">
        <span className="clbook__tile" aria-hidden="true">
          {initials(client.name)}
        </span>
        <span className="clbook__who">
          <span className="clbook__name">{client.name}</span>
          <span className="clbook__industry">{client.industry}</span>
        </span>
      </div>
      <span className="clbook__go">
        <a
          className="clbook__door"
          href={board}
          data-dock-open="todos"
          data-dock-place={board}
          aria-label="Open Projects, every client's work"
          title="Open Projects, every client's work"
        >
          <Icon name="briefcase" size="sm" />
        </a>
      </span>
      {client.waiting > 0 ? (
        <span className="clbook__waiting">
          <Icon name="comment-alt" size="sm" />
          <Count n={client.waiting} look="corner" label="client messages waiting on us" />
        </span>
      ) : null}
    </li>
  );
}

export function ClientsScreen(props: { readonly book?: ClientBook | undefined }): ReactElement {
  const book = props.book ?? MADE_UP_BOOK;
  const [query, setQuery] = useState('');
  const shown = search(book, query);
  const asked = query.trim();
  return (
    <div className="clbook">
      <MockRegion word>
        <p className="clbook__note">
          Made up for the look: client records are not built yet, so these clients and their counts
          are samples.
        </p>
        <div className="clbook__find">
          <input
            className="tf"
            type="search"
            aria-label="Search clients"
            placeholder="Search clients"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <p className="clbook__count">{countLine(shown, book)}</p>
        {shown.length === 0 ? (
          <p className="clbook__empty">
            {asked === ''
              ? 'The book holds no clients yet.'
              : `No client in the book matches “${asked}”.`}
          </p>
        ) : (
          <ul className="clbook__list">
            {shown.map((client) => (
              <Row key={client.slug} client={client} />
            ))}
          </ul>
        )}
      </MockRegion>
    </div>
  );
}

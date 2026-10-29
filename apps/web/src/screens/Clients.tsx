// SPDX-License-Identifier: AGPL-3.0-only
//
// THE CLIENTS PANEL (DOCK.md section 2; the dock's `clients`): the client book
// as a list kept beside any page, and at `/clients/` that list in full-page
// form until MP-8-5's CRM board takes the address.
//
// The book is the business's own clients as `client.list` (C32) names them:
// those the reader's grants reach, A to Z. The count counts the book it draws,
// never a second total, and a search that finds nothing says so in a sentence
// (D-6). Nothing in it is made up.
//
// **Add client** sends `client.create` with the typed name, under the server's
// own check (`record:write`, never an agent's); a refusal is quoted in the
// server's words and a landed one rereads the book. One typed name is one
// attempt: a send whose answer was lost keeps its `operationId` until an
// answer comes back, so pressing Add again on that name, even after editing
// it and back, is the same attempt and the server replays the client it made.
// The book and the form are keyed on the grant, so an answer from before a
// business or person switch touches nothing after it.
//
// A row's door is Tasks filtered to that client (`/projects/?f=client:"<name>"`,
// the board's Client facet), by the dock's gesture law when the Tasks panel
// is registered (plain solos, shift stacks) and as a link when it is not. The
// board names a row's client only where the reader's grants reach it, as
// `client.list` does. Not drawn: a press walking to the client's record
// (MP-10-1's), Portal, Docs, and counts of open work or waiting messages, which
// no read serves yet.
//
// Opened at a client (CS-7.29: an inbox group head's door, `/clients/?client=`),
// the panel marks that client above the book, by the name the read gives. A
// client the read leaves out, gone or another business's, is said in a
// sentence that names nothing of it. Opened at another client, the panel asks
// `client.list` again and marks nothing until that read answers.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Icon, clientFacetId } from '@launchastro/ui';
import type { ClientListResult, ClientView } from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import { isUnavailable, type CallResult, type OperationsClient } from '../operations/client.ts';
import { useCommand } from '../records/use-command.ts';
import { RecordState } from '../views/record-state.tsx';
import { pathTo } from '../routes.ts';

const initials = (name: string): string =>
  name
    .replaceAll('&', ' ')
    .split(/\s+/u)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('');

/** The book's clients A to Z whose name holds the query, whatever the case. */
function search(clients: readonly ClientView[], query: string): readonly ClientView[] {
  const wanted = query.trim().toLowerCase();
  return clients
    .filter((client) => wanted === '' || client.name.toLowerCase().includes(wanted))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The Tasks door: to `place`, by the dock's gesture law, or as a link without a dock. */
function ProjectsDoor(props: { readonly place: string; readonly label: string }): ReactElement {
  return (
    <span className="clbook__go">
      <a
        className="clbook__door"
        href={props.place}
        data-dock-open="todos"
        data-dock-place={props.place}
        aria-label={props.label}
        title={props.label}
      >
        <Icon name="briefcase" size="sm" />
      </a>
    </span>
  );
}

/** The board filtered to one client, by the Client facet's key for its name. */
const boardOf = (name: string): string =>
  `${pathTo('agency:projects-board')}?${new URLSearchParams({ f: clientFacetId(name) }).toString()}`;

function ClientRow(props: { readonly client: ClientView }): ReactElement {
  const { name } = props.client;
  return (
    <>
      <div className="clbook__row">
        <span className="clbook__tile" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="clbook__who">
          <span className="clbook__name">{name}</span>
        </span>
      </div>
      <ProjectsDoor place={boardOf(name)} label={`Open Tasks, ${name}'s work`} />
    </>
  );
}

/** The book as `client.list` answered it: search, the count, and the rows. */
export function Book(props: { readonly clients: readonly ClientView[] }): ReactElement {
  const [query, setQuery] = useState('');
  const shown = search(props.clients, query);
  const asked = query.trim();
  return (
    <>
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
      <p className="clbook__count">
        {`${String(shown.length)} of ${String(props.clients.length)} clients`}
      </p>
      {shown.length === 0 ? (
        <p className="clbook__empty">
          {asked === ''
            ? 'The book holds no clients yet.'
            : `No client in the book matches “${asked}”.`}
        </p>
      ) : (
        <ul className="clbook__list">
          {shown.map((client) => (
            <li key={client.clientId} className="clbook__item">
              <ClientRow client={client} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface AddClientProps {
  readonly client: OperationsClient;
  readonly onAdded: () => void;
}

/** The typed name through `client.create`, one attempt per name until it is answered. */
function useAddClient(props: AddClientProps) {
  const [name, setName] = useState('');
  const { busy, because, run } = useCommand();
  // Each typed name's attempt id, kept until that attempt is answered.
  // A Map, so a name like `constructor` never finds an inherited value.
  const held = useRef(new Map<string, string>());
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '' || busy) return;
    const operationId = held.current.get(wanted) ?? props.client.newOperationId();
    held.current.set(wanted, operationId);
    run(
      async () => {
        const answer = await props.client.mutate(
          'client.create',
          { name: wanted },
          { operationId },
        );
        if (!isUnavailable(answer)) held.current.delete(wanted);
        return answer;
      },
      (settlement) => {
        if (settlement.kind !== 'ok') return;
        // Only the name it sent: one typed while it was out stays.
        setName((now) => (now.trim() === wanted ? '' : now));
        props.onAdded();
      },
    );
  };
  return { name, setName, busy, because, submit };
}

/** Add client: a name and the button; a refusal is quoted in the server's words. */
function AddClient(props: AddClientProps): ReactElement {
  const { name, setName, busy, because, submit } = useAddClient(props);
  return (
    <form className="clbook__add" data-client-add onSubmit={submit}>
      <input
        className="tf"
        type="text"
        aria-label="New client's name"
        placeholder="New client's name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <button className="btn btn--secondary btn--sm" type="submit" disabled={busy}>
        Add client
      </button>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </form>
  );
}

/** The client the panel was opened at, named only where `client.list` names it. */
function OpenedClient(props: {
  readonly clients: readonly ClientView[];
  readonly clientId: string;
}): ReactElement {
  const found = props.clients.find((each) => each.clientId === props.clientId);
  if (found === undefined) {
    return (
      <p className="clbook__opened clbook__empty">The client you opened is not in your book.</p>
    );
  }
  return (
    <div className="clbook__opened clbook__item" aria-current="true">
      <ClientRow client={found} />
    </div>
  );
}

/** An answer with no client list is not drawn as one: the book says it is unavailable. */
function listOrUnavailable(answer: CallResult<ClientListResult>): CallResult<ClientListResult> {
  if (!('ok' in answer) || Array.isArray(answer.value.clients)) return answer;
  return {
    unavailable: true,
    because: 'The API answered with something this screen could not read.',
  };
}

interface ClientsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The client the panel's place names (CS-7.29). */
  readonly at?: string | undefined;
}

/** One business's book and Add client: a grant change starts both afresh, so nothing carries across. */
export function ClientsScreen(props: ClientsProps): ReactElement {
  return <ClientsOf key={props.grantKey} {...props} />;
}

function ClientsOf(props: ClientsProps): ReactElement {
  const { client } = props;
  // A new opened client is read afresh: the book read for the last one may
  // name a client whose grant has since gone (CS-7.29).
  const { state, reload, own } = useRead<ClientListResult>({
    grantKey: props.grantKey,
    run: async () => listOrUnavailable(await client.read<ClientListResult>('client.list', {})),
    deps: [client, props.at],
  });
  return (
    <div className="clbook">
      <AddClient client={client} onAdded={reload} />
      <RecordState state={state} subject="clients" onRetry={reload} keep>
        {(listed) => (
          <>
            {props.at === undefined || !own ? null : (
              <OpenedClient key={props.at} clients={listed.clients} clientId={props.at} />
            )}
            <Book clients={listed.clients} />
          </>
        )}
      </RecordState>
    </div>
  );
}

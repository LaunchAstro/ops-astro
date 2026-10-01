// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects panel's scope switch (MP-7-2, CS-7.4): a teammate from
// `person.list`, or a client, its waiting comments and its route family.
// Each choice replaces the scope before it, and none writes. The teammates
// are real; the clients come through `ClientSource` and are drawn under the
// one shared mock label while they are made-up (`todo-scope.ts`).

import type { ReactElement } from 'react';
import { SourceRegion } from '@launchastro/ui';
import type { PersonListResult } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import {
  MINE,
  wordsOf,
  type ClientChoice,
  type ClientSource,
  type TodoScope,
} from './todo-scope.ts';

export interface TodoScopeSwitchProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly scope: TodoScope;
  readonly onScope: (scope: TodoScope) => void;
  readonly clients: ClientSource;
}

export function TodoScopeSwitch(props: TodoScopeSwitchProps): ReactElement {
  const { scope, onScope } = props;
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => props.client.read<PersonListResult>('person.list', {}),
    deps: [],
  });
  const persons = people.state.outcome === 'ready' ? people.state.value.persons : [];
  const words = wordsOf(scope);
  return (
    <div className="todos__scope">
      <Choice
        id="todos-person"
        label="Whose to-dos"
        none="Mine"
        value={scope.kind === 'person' ? scope.personId : ''}
        options={persons.map((person) => ({ value: person.personId, label: person.name }))}
        onPick={(value) => {
          const person = persons.find((each) => each.personId === value);
          onScope(person === undefined ? MINE : { kind: 'person', ...person });
        }}
      />
      <SourceRegion provenance={props.clients.provenance}>
        <ClientScope {...props} />
      </SourceRegion>
      {words === null ? null : (
        <p className="card__sub">
          <span data-todos-scope>{words}</span>{' '}
          <button className="btn" type="button" data-todos="mine" onClick={() => onScope(MINE)}>
            Back to mine
          </button>
        </p>
      )}
    </div>
  );
}

/** A client, its waiting comments and its route family: one client scope, replaced whole. */
function ClientScope(props: TodoScopeSwitchProps): ReactElement {
  const { scope, onScope, clients } = props;
  const chosen =
    scope.kind === 'client'
      ? clients.clients.find((each) => each.id === scope.clientId)
      : undefined;
  const to = (client: ClientChoice | undefined, over: { waiting?: boolean; family?: string }) => {
    onScope(
      client === undefined
        ? MINE
        : { kind: 'client', clientId: client.id, name: client.name, ...over },
    );
  };
  const waiting = scope.kind === 'client' && scope.waiting === true;
  return (
    <div className="todos__scope" data-todos-clients>
      <Choice
        id="todos-client"
        label="Client"
        none="No client"
        value={chosen?.id ?? ''}
        options={clients.clients.map((client) => ({ value: client.id, label: client.name }))}
        onPick={(value) => {
          to(
            clients.clients.find((each) => each.id === value),
            {},
          );
        }}
      />
      <WaitingBox
        disabled={chosen === undefined}
        checked={waiting}
        onToggle={() => {
          to(chosen, { waiting: !waiting });
        }}
      />
      <Choice
        id="todos-family"
        label="Route family"
        none="Any route"
        disabled={chosen === undefined}
        value={scope.kind === 'client' ? (scope.family ?? '') : ''}
        options={(chosen?.families ?? []).map((family) => ({ value: family, label: family }))}
        onPick={(value) => {
          to(chosen, value === '' ? {} : { family: value });
        }}
      />
    </div>
  );
}

/** Only the client's tasks with messages waiting on us. */
function WaitingBox(props: {
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <label>
      <input
        id="todos-waiting"
        type="checkbox"
        disabled={props.disabled}
        checked={props.checked}
        onChange={props.onToggle}
      />{' '}
      Waiting on us
    </label>
  );
}

/** One select of the switch: a "none" choice, then its options. */
function Choice(props: {
  readonly id: string;
  readonly label: string;
  readonly none: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onPick: (value: string) => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <select
      id={props.id}
      className="input"
      aria-label={props.label}
      disabled={props.disabled === true}
      value={props.value}
      onChange={(event) => {
        props.onPick(event.target.value);
      }}
    >
      <option value="">{props.none}</option>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

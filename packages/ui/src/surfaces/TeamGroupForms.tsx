// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's group forms (C71-G): starting a group with a name and two
// or more of the strip's teammates, and renaming one. Both send trimmed words
// and nothing when the words are empty. Each teammate is picked with the kit's
// checkbox, its label the teammate's name.

import { useState, type ReactElement } from 'react';
import { Checkbox } from '../kit/controls-toggles.tsx';
import type { GroupAction, GroupThread, Teammate } from '../state/team.ts';

type Act = (action: GroupAction) => void;

/** A name and two or more teammates. */
export function StartGroup(props: {
  readonly teammates: readonly Teammate[];
  readonly onGroup: Act;
  readonly onClose: () => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const said = name.trim();
  const ready = said !== '' && chosen.length >= 2;
  const toggle = (id: string): void => {
    setChosen((was) => (was.includes(id) ? was.filter((c) => c !== id) : [...was, id]));
  };
  return (
    <form
      className="tmc__new"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        props.onGroup({ do: 'start', name: said, members: chosen });
        props.onClose();
      }}
    >
      <NameField value={name} onChange={setName} />
      <fieldset className="tmc__pick">
        <legend>With</legend>
        {props.teammates.map((person) => (
          <label key={person.personId} data-pick={person.personId}>
            <Checkbox
              label={person.name}
              checked={chosen.includes(person.personId)}
              onChange={() => {
                toggle(person.personId);
              }}
            />
            {person.name}
          </label>
        ))}
      </fieldset>
      <FormButtons label="Start" disabled={!ready} onCancel={props.onClose} />
    </form>
  );
}

function NameField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="tmc__why">
      Name
      <input
        name="name"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
    </label>
  );
}

function FormButtons(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <>
      <button type="submit" className="btn btn--primary btn--sm" disabled={props.disabled}>
        {props.label}
      </button>
      <button type="button" className="btn btn--sm tmc__cancel" onClick={props.onCancel}>
        Cancel
      </button>
    </>
  );
}

export function Rename(props: {
  readonly group: GroupThread;
  readonly onGroup: Act;
  readonly onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(props.group.name);
  const said = name.trim();
  return (
    <form
      className="tmc__renaming"
      onSubmit={(event) => {
        event.preventDefault();
        if (said === '') return;
        props.onGroup({ do: 'rename', id: props.group.id, name: said });
        props.onClose();
      }}
    >
      <NameField value={name} onChange={setName} />
      <FormButtons label="Rename" disabled={said === ''} onCancel={props.onClose} />
    </form>
  );
}

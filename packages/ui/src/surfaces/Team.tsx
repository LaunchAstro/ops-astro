// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Team panel (MP-7-10): the people strip and the person's own
// availability, with the room below it where team chat sits (C71-D, C71-G).
//
// Each teammate is two controls, never one control doing two jobs by where it
// was pressed: the face selects them here, the name is the door to their work.
// Away is the word Away and a dashed ring, with the person's own reason on the
// face; it is only ever what they set, so nothing here watches time or input.

import { useState, type ReactElement } from 'react';
import {
  teammatesOf,
  type Availability,
  type AvailabilityChange,
  type DirectThread,
  type Teammate,
} from '../state/team.ts';
import { follow, type OpenHow } from './gesture.ts';

export interface TeamPanelProps {
  /** Every member the reader works with, the reader included. */
  readonly people: readonly Teammate[];
  /** The reader's own person id. */
  readonly me: string;
  /** Where a teammate's work opens (Projects scoped to them). */
  readonly workHref: (personId: string) => string;
  readonly onOpenWork: (personId: string, how: OpenHow) => void;
  readonly onSetAvailability: (change: AvailabilityChange) => void;
  /** The reader's direct conversations, as the comment read returned them (C71-D). */
  readonly threads: readonly DirectThread[];
  /** Move the reader's own read marker on the conversation with this teammate. */
  readonly onMarkRead: (withPerson: string, upTo: string) => void;
  /** Send a direct message: a comment with a two-person audience, through MP-4-5's comment command. */
  readonly onSend: (toPerson: string, body: string) => void;
}

function Chip(props: {
  readonly person: Teammate;
  readonly on: boolean;
  readonly onSelect: () => void;
  readonly panel: TeamPanelProps;
}): ReactElement {
  const { person, on, panel } = props;
  const label =
    person.away === null
      ? `Message ${person.name}`
      : `Message ${person.name}, away: ${person.away.reason}`;
  return (
    <span
      className={`tmc__p${on ? ' is-on' : ''}${person.away === null ? '' : ' tmc__p--away'}`}
      data-person={person.personId}
    >
      <button
        type="button"
        className="tmc__face"
        aria-pressed={on}
        aria-label={label}
        title={label}
        onClick={props.onSelect}
      >
        <span className="tmc__av" aria-hidden="true">
          {person.initials}
        </span>
      </button>
      <a
        className="tmc__n"
        href={panel.workHref(person.personId)}
        title={`See everything assigned to ${person.short}`}
        onClick={(event) => {
          follow(event, (how) => {
            panel.onOpenWork(person.personId, how);
          });
        }}
      >
        {person.short}
        <span className="tmc__door" aria-hidden="true" />
      </a>
      {person.away === null ? null : <span className="tmc__away">Away</span>}
    </span>
  );
}

/** The reader's own availability: in, or away with their reason. */
function Mine(props: {
  readonly away: Availability | null;
  readonly onSet: (change: AvailabilityChange) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const said = reason.trim();

  if (editing) {
    return (
      <form
        className="tmc__me"
        onSubmit={(event) => {
          event.preventDefault();
          if (said === '') return;
          props.onSet({ away: true, reason: said });
          setEditing(false);
          setReason('');
        }}
      >
        <label className="tmc__why">
          Why you are away
          <input
            name="reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="btn btn--primary btn--sm" disabled={said === ''}>
          Away
        </button>
        <button
          type="button"
          className="btn btn--sm tmc__cancel"
          onClick={() => {
            setEditing(false);
            setReason('');
          }}
        >
          Cancel
        </button>
      </form>
    );
  }

  if (props.away !== null) {
    return (
      <p className="tmc__me">
        <span>{`You are away: ${props.away.reason}`}</span>
        <button
          type="button"
          className="btn btn--sm tmc__back"
          onClick={() => {
            props.onSet({ away: false });
          }}
        >
          Back in
        </button>
      </p>
    );
  }

  return (
    <p className="tmc__me">
      <span>You are in</span>
      <button
        type="button"
        className="btn btn--sm tmc__set"
        onClick={() => {
          setEditing(true);
        }}
      >
        Set yourself away
      </button>
    </p>
  );
}

export function TeamPanel(props: TeamPanelProps): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const mine = props.people.find((person) => person.personId === props.me);
  return (
    <div className="tmc">
      <Mine away={mine?.away ?? null} onSet={props.onSetAvailability} />
      <div className="tmc__strip">
        {teammatesOf(props.people, props.me).map((person) => (
          <Chip
            key={person.personId}
            person={person}
            on={person.personId === selected}
            onSelect={() => {
              setSelected(person.personId);
            }}
            panel={props}
          />
        ))}
      </div>
      <div className="tmc__conv">
        {selected === null ? <p className="dp__empty">Nobody selected.</p> : null}
      </div>
    </div>
  );
}

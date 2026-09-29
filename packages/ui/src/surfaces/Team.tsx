// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Team panel (MP-7-10, C71-D): the people strip, the person's own
// availability, and the direct conversation with the teammate selected.
//
// Each teammate is two controls, never one control doing two jobs by where it
// was pressed: the face opens the conversation here, the name is the door to
// their work. Away is the word Away and a dashed ring, with the person's own
// reason on the face; it is only ever what they set, so nothing here watches
// time or input.
//
// Unread is derived from the reader's own read marker and nothing else. The
// panel opens on the first conversation with anything unread without reading
// it; the marker moves on a click into the conversation or on the face, and a
// send moves it in the comment command's own transaction (R36). Messages are
// comments on the one comment record, drawn in the task thread's dialect.

import { useState, type ReactElement } from 'react';
import {
  newestAt,
  openingThread,
  teammatesOf,
  unreadOf,
  type Availability,
  type AvailabilityChange,
  type DirectThread,
  type GroupAction,
  type GroupThread,
  type Teammate,
} from '../state/team.ts';
import { follow, type OpenHow } from './gesture.ts';
import { Conversation } from './TeamConversation.tsx';

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
  /** The group conversations the reader is a member of, as the comment read returned them (C71-G). */
  readonly groups: readonly GroupThread[];
  readonly onGroup: (action: GroupAction) => void;
}

/** The face says whom it messages and, when they set it, why they are away. */
const faceLabel = (person: Teammate): string =>
  person.away === null
    ? `Message ${person.name}`
    : `Message ${person.name}, away: ${person.away.reason}`;

function Chip(props: {
  readonly person: Teammate;
  readonly on: boolean;
  readonly unread: number;
  readonly onSelect: () => void;
  readonly panel: TeamPanelProps;
}): ReactElement {
  const { person, on, panel } = props;
  const label = faceLabel(person);
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
      {props.unread > 0 ? (
        <span className="cbadge tmc__u" aria-label={`${String(props.unread)} unread`}>
          {props.unread}
        </span>
      ) : null}
    </span>
  );
}

/** Setting Away: the reason is required, in the person's own words. */
function AwayForm(props: {
  readonly onSet: (change: AvailabilityChange) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState('');
  const said = reason.trim();
  return (
    <form
      className="tmc__me"
      onSubmit={(event) => {
        event.preventDefault();
        if (said === '') return;
        props.onSet({ away: true, reason: said });
        props.onClose();
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
      <button type="button" className="btn btn--sm tmc__cancel" onClick={props.onClose}>
        Cancel
      </button>
    </form>
  );
}

/** The reader's own availability: in, or away with their reason. */
function Mine(props: {
  readonly away: Availability | null;
  readonly onSet: (change: AvailabilityChange) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <AwayForm
        onSet={props.onSet}
        onClose={() => {
          setEditing(false);
        }}
      />
    );
  }
  const away = props.away;
  return (
    <p className="tmc__me">
      <span>{away === null ? 'You are in' : `You are away: ${away.reason}`}</span>
      <button
        type="button"
        className={`btn btn--sm ${away === null ? 'tmc__set' : 'tmc__back'}`}
        onClick={() => {
          if (away === null) setEditing(true);
          else props.onSet({ away: false });
        }}
      >
        {away === null ? 'Set yourself away' : 'Back in'}
      </button>
    </p>
  );
}

function Strip(props: {
  readonly teammates: readonly Teammate[];
  readonly selected: string | null;
  readonly unread: (personId: string) => number;
  readonly onSelect: (personId: string) => void;
  readonly panel: TeamPanelProps;
}): ReactElement {
  return (
    <div className="tmc__strip">
      {props.teammates.map((person) => (
        <Chip
          key={person.personId}
          person={person}
          on={person.personId === props.selected}
          unread={props.unread(person.personId)}
          onSelect={() => {
            props.onSelect(person.personId);
          }}
          panel={props.panel}
        />
      ))}
    </div>
  );
}

export function TeamPanel(props: TeamPanelProps): ReactElement {
  const [selected, setSelected] = useState<string | null>(() =>
    openingThread(props.threads, props.me),
  );
  const mine = props.people.find((person) => person.personId === props.me);
  const teammates = teammatesOf(props.people, props.me);
  const threadWith = (id: string): DirectThread | undefined =>
    props.threads.find((thread) => thread.with === id);
  const read = (id: string): void => {
    const thread = threadWith(id);
    const upTo = thread === undefined ? null : newestAt(thread);
    if (thread !== undefined && upTo !== null && unreadOf(thread, props.me) > 0) {
      props.onMarkRead(id, upTo);
    }
  };
  const open = teammates.find((person) => person.personId === selected);
  return (
    <div className="tmc">
      <Mine away={mine?.away ?? null} onSet={props.onSetAvailability} />
      <Strip
        teammates={teammates}
        selected={selected}
        unread={(id) => {
          const thread = threadWith(id);
          return thread === undefined ? 0 : unreadOf(thread, props.me);
        }}
        onSelect={(id) => {
          setSelected(id);
          read(id);
        }}
        panel={props}
      />
      <div className="tmc__conv">
        {open === undefined ? (
          <p className="dp__empty">Nobody selected.</p>
        ) : (
          <Conversation
            to={open}
            thread={threadWith(open.personId)}
            me={props.me}
            onRead={() => {
              read(open.personId);
            }}
            onSend={props.onSend}
          />
        )}
      </div>
    </div>
  );
}

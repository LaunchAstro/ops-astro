// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's strip (MP-7-10): each teammate as two controls, the face
// and the name, never one control doing two jobs by where it was pressed.
// The face opens the conversation when the host gives conversations and is a
// plain face otherwise; the name is the door to their work when the host has
// a view of it and plain text otherwise. Away is the word Away and a dashed
// ring, with the person's own reason, if they gave one, on the face.

import type { ReactElement } from 'react';
import type { Teammate } from '../state/team.ts';
import { follow, type OpenHow } from './gesture.ts';

/** A teammate's name as the door to their work (Projects scoped to them). */
export interface TeamWork {
  readonly href: (personId: string) => string;
  readonly onOpen: (personId: string, how: OpenHow) => void;
}

/** The reason on the face, only ever the person's own; away with none given says just that. */
const awayWords = (person: Teammate): string => {
  if (person.away === null) return '';
  return person.away.reason === null ? ', away' : `, away: ${person.away.reason}`;
};

/** The face says who it is and, when they set it, why they are away; with conversations, whom it messages. */
const faceLabel = (person: Teammate, messages: boolean): string =>
  `${messages ? `Message ${person.name}` : person.name}${awayWords(person)}`;

function Face(props: {
  readonly person: Teammate;
  readonly on: boolean;
  readonly onSelect: (() => void) | null;
}): ReactElement {
  const { person } = props;
  const face = (
    <span className="tmc__av" aria-hidden="true">
      {person.initials}
    </span>
  );
  if (props.onSelect === null) {
    const label = faceLabel(person, false);
    return (
      <span className="tmc__face" role="img" aria-label={label} title={label}>
        {face}
      </span>
    );
  }
  const label = faceLabel(person, true);
  return (
    <button
      type="button"
      className="tmc__face"
      aria-pressed={props.on}
      aria-label={label}
      title={label}
      onClick={props.onSelect}
    >
      {face}
    </button>
  );
}

function Name(props: { readonly person: Teammate; readonly work: TeamWork | null }): ReactElement {
  const { person, work } = props;
  if (work === null) return <span className="tmc__n">{person.short}</span>;
  return (
    <a
      className="tmc__n"
      href={work.href(person.personId)}
      title={`See everything assigned to ${person.short}`}
      onClick={(event) => {
        follow(event, (how) => {
          work.onOpen(person.personId, how);
        });
      }}
    >
      {person.short}
      <span className="tmc__door" aria-hidden="true" />
    </a>
  );
}

function Chip(props: {
  readonly person: Teammate;
  readonly on: boolean;
  readonly unread: number;
  readonly onSelect: (() => void) | null;
  readonly work: TeamWork | null;
}): ReactElement {
  const { person, on } = props;
  return (
    <span
      className={`tmc__p${on ? ' is-on' : ''}${person.away === null ? '' : ' tmc__p--away'}`}
      data-person={person.personId}
    >
      <Face person={person} on={on} onSelect={props.onSelect} />
      <Name person={person} work={props.work} />
      {person.away === null ? null : <span className="tmc__away">Away</span>}
      {props.unread > 0 ? (
        <span className="cbadge tmc__u" aria-label={`${String(props.unread)} unread`}>
          {props.unread}
        </span>
      ) : null}
    </span>
  );
}

export function Strip(props: {
  readonly teammates: readonly Teammate[];
  readonly selected: string | null;
  readonly unread: (personId: string) => number;
  readonly onSelect: ((personId: string) => void) | null;
  readonly work: TeamWork | null;
}): ReactElement {
  const { onSelect } = props;
  return (
    <div className="tmc__strip">
      {props.teammates.map((person) => (
        <Chip
          key={person.personId}
          person={person}
          on={person.personId === props.selected}
          unread={props.unread(person.personId)}
          onSelect={
            onSelect === null
              ? null
              : () => {
                  onSelect(person.personId);
                }
          }
          work={props.work}
        />
      ))}
    </div>
  );
}

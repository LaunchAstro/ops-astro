// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Team panel (MP-7-10, C71-D, C71-G): the people strip, the
// person's own availability, the group list, and the conversation selected,
// direct or group.
//
// Each teammate is two controls, never one control doing two jobs by where it
// was pressed: the face opens the conversation here, the name is the door to
// their work. Away is the word Away and a dashed ring, with the person's own
// reason on the face; it is only ever what they set, so nothing here watches
// time or input.
//
// Unread is derived from the reader's own read marker and nothing else. The
// panel opens on the first conversation with anything unread (direct first,
// then groups) without reading it; the marker moves on a click into the conversation or on the face, and a
// send moves it in the comment command's own transaction (R36). Messages are
// comments on the one comment record, drawn in the task thread's dialect.

import { useState, type ReactElement } from 'react';
import {
  newestAt,
  openingGroup,
  openingThread,
  teammatesOf,
  unreadOf,
  type AvailabilityChange,
  type DirectThread,
  type GroupAction,
  type GroupThread,
  type TeamConversation,
  type Teammate,
} from '../state/team.ts';
import { follow, type OpenHow } from './gesture.ts';
import { Conversation } from './TeamConversation.tsx';
import { Mine } from './TeamAvailability.tsx';
import { GroupHead, GroupList } from './TeamGroups.tsx';

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

/** What the conversation pane shows: a teammate's direct conversation or a group. */
type Selected = { readonly kind: 'person' | 'group'; readonly id: string } | null;

function opening(props: TeamPanelProps): Selected {
  const person = openingThread(props.threads, props.me);
  if (person !== null) return { kind: 'person', id: person };
  const group = openingGroup(props.groups, props.me);
  return group === null ? null : { kind: 'group', id: group };
}

/** Move the reader's own marker to the newest message, only when something is unread. */
function markRead(
  thread: TeamConversation | undefined,
  me: string,
  move: (upTo: string) => void,
): void {
  const upTo = thread === undefined ? null : newestAt(thread);
  if (thread !== undefined && upTo !== null && unreadOf(thread, me) > 0) move(upTo);
}

function OpenConversation(props: {
  readonly panel: TeamPanelProps;
  readonly selected: Selected;
  readonly teammates: readonly Teammate[];
  readonly threadWith: (id: string) => DirectThread | undefined;
  readonly read: (selected: Selected) => void;
}): ReactElement {
  const { panel, selected } = props;
  const person =
    selected?.kind === 'person'
      ? props.teammates.find((p) => p.personId === selected.id)
      : undefined;
  const group =
    selected?.kind === 'group' ? panel.groups.find((g) => g.id === selected.id) : undefined;
  const onRead = (): void => {
    props.read(selected);
  };
  if (person !== undefined) {
    return (
      <Conversation
        id={person.personId}
        to={person.short}
        thread={props.threadWith(person.personId)}
        me={panel.me}
        onRead={onRead}
        onSend={(body) => {
          panel.onSend(person.personId, body);
        }}
      />
    );
  }
  if (group === undefined) return <p className="dp__empty">Nobody selected.</p>;
  return (
    <>
      <GroupHead group={group} me={panel.me} teammates={props.teammates} onGroup={panel.onGroup} />
      <Conversation
        id={group.id}
        to={group.name}
        thread={group}
        me={panel.me}
        onRead={onRead}
        onSend={(body) => {
          panel.onGroup({ do: 'send', id: group.id, body });
        }}
      />
    </>
  );
}

/** Read the selected conversation: the direct marker by `onMarkRead`, a group's by its `read` action. */
function reader(props: TeamPanelProps): (which: Selected) => void {
  return (which) => {
    if (which?.kind === 'person') {
      const thread = props.threads.find((t) => t.with === which.id);
      markRead(thread, props.me, (upTo) => {
        props.onMarkRead(which.id, upTo);
      });
    } else if (which?.kind === 'group') {
      markRead(
        props.groups.find((g) => g.id === which.id),
        props.me,
        (upTo) => {
          props.onGroup({ do: 'read', id: which.id, upTo });
        },
      );
    }
  };
}

export function TeamPanel(props: TeamPanelProps): ReactElement {
  const [selected, setSelected] = useState<Selected>(() => opening(props));
  const mine = props.people.find((person) => person.personId === props.me);
  const teammates = teammatesOf(props.people, props.me);
  const threadWith = (id: string): DirectThread | undefined =>
    props.threads.find((thread) => thread.with === id);
  const read = reader(props);
  const select = (which: Selected): void => {
    setSelected(which);
    read(which);
  };
  return (
    <div className="tmc">
      <Mine away={mine?.away ?? null} onSet={props.onSetAvailability} />
      <Strip
        teammates={teammates}
        selected={selected?.kind === 'person' ? selected.id : null}
        unread={(id) => {
          const thread = threadWith(id);
          return thread === undefined ? 0 : unreadOf(thread, props.me);
        }}
        onSelect={(id) => {
          select({ kind: 'person', id });
        }}
        panel={props}
      />
      <GroupList
        groups={props.groups}
        selected={selected?.kind === 'group' ? selected.id : null}
        unread={(group) => unreadOf(group, props.me)}
        onSelect={(id) => {
          select({ kind: 'group', id });
        }}
        teammates={teammates}
        onGroup={props.onGroup}
      />
      <div className="tmc__conv">
        <OpenConversation
          panel={props}
          selected={selected}
          teammates={teammates}
          threadWith={threadWith}
          read={read}
        />
      </div>
    </div>
  );
}

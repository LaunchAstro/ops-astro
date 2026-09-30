// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Team panel (MP-7-10, C71-D, C71-G): the people strip, the
// person's own availability, the group list, and the conversation selected,
// direct or group.
//
// Each teammate is two controls (`TeamStrip.tsx`): the face opens the
// conversation here, the name is the door to their work. Away is only ever
// what the person set, so nothing here watches time or input.
//
// Unread is derived from the reader's own read marker and nothing else. The
// panel opens on the first conversation with anything unread (direct first,
// then groups) without reading it; the marker moves on a click into the conversation or on the face, and a
// send moves it in the comment command's own transaction (R36). Messages are
// comments on the one comment record, drawn in the task thread's dialect.
//
// The door and the conversations are each the host's to give or withhold: a
// host with no view of a person's work passes `work: null` and the name is
// plain text; one with no comment read for conversations passes
// `conversations: null`, and a face is then a face that opens nothing, with
// no group list and an empty conversation room. The strip and the reader's
// own availability never wait on either.

import { useState, type ReactElement } from 'react';
import { Empty } from '../primitives/Absence.tsx';
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
import { Conversation } from './TeamConversation.tsx';
import { Mine } from './TeamAvailability.tsx';
import { GroupHead, GroupList } from './TeamGroups.tsx';
import { Strip, type TeamWork } from './TeamStrip.tsx';

export type { TeamWork } from './TeamStrip.tsx';

/** The reader's conversations and what they may do in them (C71-D, C71-G). */
export interface TeamConversations {
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

export interface TeamPanelProps {
  /** Every member the reader works with, the reader included. */
  readonly people: readonly Teammate[];
  /** The reader's own person id. */
  readonly me: string;
  readonly onSetAvailability: (change: AvailabilityChange) => void;
  /** Null while the host has no view of a person's work: the name is plain text. */
  readonly work: TeamWork | null;
  /** Null while the host has no comment read for them: a face opens nothing and the room stays empty. */
  readonly conversations: TeamConversations | null;
}

/** What the conversation pane shows: a teammate's direct conversation or a group. */
type Selected = { readonly kind: 'person' | 'group'; readonly id: string } | null;

function opening(talk: TeamConversations | null, me: string): Selected {
  if (talk === null) return null;
  const person = openingThread(talk.threads, me);
  if (person !== null) return { kind: 'person', id: person };
  const group = openingGroup(talk.groups, me);
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
  readonly talk: TeamConversations;
  readonly me: string;
  readonly selected: Selected;
  readonly teammates: readonly Teammate[];
  readonly threadWith: (id: string) => DirectThread | undefined;
  readonly read: (selected: Selected) => void;
}): ReactElement {
  const { talk, me, selected } = props;
  const person =
    selected?.kind === 'person'
      ? props.teammates.find((p) => p.personId === selected.id)
      : undefined;
  const group =
    selected?.kind === 'group' ? talk.groups.find((g) => g.id === selected.id) : undefined;
  const onRead = (): void => {
    props.read(selected);
  };
  if (person !== undefined) {
    return (
      <Conversation
        id={person.personId}
        to={person.short}
        thread={props.threadWith(person.personId)}
        me={me}
        onRead={onRead}
        onSend={(body) => {
          talk.onSend(person.personId, body);
        }}
      />
    );
  }
  if (group === undefined) return <Empty look="inline" title="Nobody selected." />;
  return (
    <>
      <GroupHead group={group} me={me} teammates={props.teammates} onGroup={talk.onGroup} />
      <Conversation
        id={group.id}
        to={group.name}
        thread={group}
        me={me}
        onRead={onRead}
        onSend={(body) => {
          talk.onGroup({ do: 'send', id: group.id, body });
        }}
      />
    </>
  );
}

/** Read the selected conversation: the direct marker by `onMarkRead`, a group's by its `read` action. */
function reader(talk: TeamConversations, me: string): (which: Selected) => void {
  return (which) => {
    if (which?.kind === 'person') {
      const thread = talk.threads.find((t) => t.with === which.id);
      markRead(thread, me, (upTo) => {
        talk.onMarkRead(which.id, upTo);
      });
    } else if (which?.kind === 'group') {
      markRead(
        talk.groups.find((g) => g.id === which.id),
        me,
        (upTo) => {
          talk.onGroup({ do: 'read', id: which.id, upTo });
        },
      );
    }
  };
}

/** The group list and the open conversation, drawn only when the host gives conversations. */
function Talk(props: {
  readonly talk: TeamConversations;
  readonly me: string;
  readonly teammates: readonly Teammate[];
  readonly selected: Selected;
  readonly select: (which: Selected) => void;
  readonly read: (which: Selected) => void;
}): ReactElement {
  const { talk, me, selected } = props;
  return (
    <>
      <GroupList
        groups={talk.groups}
        selected={selected?.kind === 'group' ? selected.id : null}
        unread={(group) => unreadOf(group, me)}
        onSelect={(id) => {
          props.select({ kind: 'group', id });
        }}
        teammates={props.teammates}
        onGroup={talk.onGroup}
      />
      <div className="tmc__conv" data-team="conversations">
        <OpenConversation
          talk={talk}
          me={me}
          selected={selected}
          teammates={props.teammates}
          threadWith={(id) => talk.threads.find((thread) => thread.with === id)}
          read={props.read}
        />
      </div>
    </>
  );
}

export function TeamPanel(props: TeamPanelProps): ReactElement {
  const talk = props.conversations;
  const [selected, setSelected] = useState<Selected>(() => opening(talk, props.me));
  const mine = props.people.find((person) => person.personId === props.me);
  const teammates = teammatesOf(props.people, props.me);
  const read = talk === null ? null : reader(talk, props.me);
  const select = (which: Selected): void => {
    setSelected(which);
    read?.(which);
  };
  const unread = (id: string): number => {
    const thread = talk?.threads.find((t) => t.with === id);
    return thread === undefined ? 0 : unreadOf(thread, props.me);
  };
  return (
    <div className="tmc">
      <Mine away={mine?.away ?? null} onSet={props.onSetAvailability} />
      <Strip
        teammates={teammates}
        selected={selected?.kind === 'person' ? selected.id : null}
        unread={unread}
        onSelect={
          talk === null
            ? null
            : (id) => {
                select({ kind: 'person', id });
              }
        }
        work={props.work}
      />
      {talk === null || read === null ? (
        <div className="tmc__conv" data-team="conversations" />
      ) : (
        <Talk
          talk={talk}
          me={props.me}
          teammates={teammates}
          selected={selected}
          select={select}
          read={read}
        />
      )}
    </div>
  );
}

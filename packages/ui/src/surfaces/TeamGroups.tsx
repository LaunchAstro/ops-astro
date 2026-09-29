// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's group conversations (C71-G): the list under the strip,
// starting a group, and the open group's head.
//
// The member picker offers the strip's teammates and nobody else, so never a
// client, an agent or the reader (the starter is a member by the command).
// Rename, add and remove show only where the server says the reader holds
// `chat:manage` on the group (its creator, the owner or an administrator);
// leave is every member's own. The command still checks every one of them:
// a control left out here is the UI half of the refusal, never the refusal.

import { useState, type ReactElement } from 'react';
import type { GroupAction, GroupThread, Teammate } from '../state/team.ts';
import { Rename, StartGroup } from './TeamGroupForms.tsx';

type Act = (action: GroupAction) => void;

function GroupItem(props: {
  readonly group: GroupThread;
  readonly on: boolean;
  readonly unread: number;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  const { group, unread } = props;
  return (
    <li data-group={group.id}>
      <button
        type="button"
        className="tmc__g"
        aria-pressed={props.on}
        onClick={() => {
          props.onSelect(group.id);
        }}
      >
        {group.name}
      </button>
      {unread > 0 ? (
        <span className="cbadge" aria-label={`${String(unread)} unread`}>
          {unread}
        </span>
      ) : null}
    </li>
  );
}

/** The list under the strip: each group with its unread, and a way to start one. */
export function GroupList(props: {
  readonly groups: readonly GroupThread[];
  readonly selected: string | null;
  readonly unread: (group: GroupThread) => number;
  readonly onSelect: (id: string) => void;
  readonly teammates: readonly Teammate[];
  readonly onGroup: Act;
}): ReactElement {
  const [starting, setStarting] = useState(false);
  return (
    <div className="tmc__groups">
      <ul className="tmc__glist">
        {props.groups.map((group) => (
          <GroupItem
            key={group.id}
            group={group}
            on={group.id === props.selected}
            unread={props.unread(group)}
            onSelect={props.onSelect}
          />
        ))}
      </ul>
      {starting ? (
        <StartGroup
          teammates={props.teammates}
          onGroup={props.onGroup}
          onClose={() => {
            setStarting(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn--sm tmc__start"
          onClick={() => {
            setStarting(true);
          }}
        >
          Start a group
        </button>
      )}
    </div>
  );
}

/** Add one teammate who is not yet a member. */
function AddMember(props: {
  readonly group: GroupThread;
  readonly outside: readonly Teammate[];
  readonly onAdd: (personId: string) => void;
}): ReactElement {
  const { group, outside } = props;
  const [adding, setAdding] = useState('');
  const pick = outside.some((person) => person.personId === adding)
    ? adding
    : (outside[0]?.personId ?? '');
  return (
    <form
      className="tmc__adding"
      onSubmit={(event) => {
        event.preventDefault();
        if (pick !== '') props.onAdd(pick);
      }}
    >
      <select
        name="person"
        aria-label={`Add to ${group.name}`}
        value={pick}
        onChange={(event) => {
          setAdding(event.target.value);
        }}
      >
        {outside.map((person) => (
          <option key={person.personId} value={person.personId}>
            {person.name}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn--sm">
        Add
      </button>
    </form>
  );
}

/** A manager's member list: remove anyone but themselves (leaving is Leave), add a teammate not yet in it. */
function Members(props: {
  readonly group: GroupThread;
  readonly others: readonly Teammate[];
  readonly teammates: readonly Teammate[];
  readonly onGroup: Act;
}): ReactElement {
  const { group } = props;
  const outside = props.teammates.filter((person) => !group.members.includes(person.personId));
  const change = (add: readonly string[], remove: readonly string[]): void => {
    props.onGroup({ do: 'members', id: group.id, add, remove });
  };
  return (
    <>
      <ul className="tmc__members">
        {props.others.map((person) => (
          <li key={person.personId} data-member={person.personId}>
            {person.short}{' '}
            <button
              type="button"
              className="btn btn--ghost btn--sm tmc__remove"
              aria-label={`Remove ${person.short} from ${group.name}`}
              onClick={() => {
                change([], [person.personId]);
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {outside.length === 0 ? null : (
        <AddMember
          group={group}
          outside={outside}
          onAdd={(id) => {
            change([id], []);
          }}
        />
      )}
    </>
  );
}

/** The group's name, Rename for a manager, and Leave for any member. */
function GroupName(props: {
  readonly group: GroupThread;
  readonly onRename: () => void;
  readonly onGroup: Act;
}): ReactElement {
  const { group } = props;
  return (
    <p className="tmc__gname">
      <b>{group.name}</b>
      {group.canManage ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm tmc__rename"
          onClick={props.onRename}
        >
          Rename
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn--ghost btn--sm tmc__leave"
        onClick={() => {
          props.onGroup({ do: 'leave', id: group.id });
        }}
      >
        Leave
      </button>
    </p>
  );
}

/** The open group's head: its name, who is in it, and what the reader may do to it. */
export function GroupHead(props: {
  readonly group: GroupThread;
  readonly me: string;
  readonly teammates: readonly Teammate[];
  readonly onGroup: Act;
}): ReactElement {
  const { group } = props;
  const [renaming, setRenaming] = useState(false);
  const others = props.teammates.filter((person) => group.members.includes(person.personId));
  const close = (): void => {
    setRenaming(false);
  };
  return (
    <div className="tmc__ghead">
      {renaming ? (
        <Rename key={group.id} group={group} onGroup={props.onGroup} onClose={close} />
      ) : (
        <GroupName
          group={group}
          onRename={() => {
            setRenaming(true);
          }}
          onGroup={props.onGroup}
        />
      )}
      <p className="tmc__with">With {others.map((person) => person.short).join(', ')}</p>
      {group.canManage ? (
        <Members
          group={group}
          others={others}
          teammates={props.teammates}
          onGroup={props.onGroup}
        />
      ) : null}
    </div>
  );
}

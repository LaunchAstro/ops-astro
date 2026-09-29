// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the conversation tab row (AI-06 to AI-08).
//
// Its own row rather than the task page's `TabStrip`, because each tab here
// renames in place and carries its own close: a tab strip whose tabs are also
// editors and doors. The keyboard is the strip's (register candidate C5): left
// and right move and wrap, Home and End jump, and focus follows the move, so
// only the selected tab sits in the tab order.

import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { AssistantChat } from '../AssistantPanel.tsx';

export const TAB_TITLE_LIMIT = 40;

export interface TabRowProps {
  readonly chats: readonly AssistantChat[];
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly onRename: (key: string, title: string) => void;
  readonly onTakeOut: (key: string) => void;
  readonly onNew: () => void;
}

const MOVES: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowRight: (at, count) => (at + 1) % count,
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
};

function Renaming(props: {
  readonly chat: AssistantChat;
  readonly onDone: (title: string | null) => void;
}): ReactElement {
  const [value, setValue] = useState(props.chat.title);
  // Enter and Escape end the edit before the field leaves the document, so
  // the blur that follows must not commit a second time.
  const done = useRef(false);
  const finish = (title: string | null): void => {
    if (done.current) return;
    done.current = true;
    props.onDone(title);
  };
  return (
    <input
      className="cmtab cmtab--rename"
      data-chat-rename={props.chat.key}
      aria-label={`Rename ${props.chat.title}`}
      maxLength={TAB_TITLE_LIMIT}
      value={value}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the double-click that opened the field asked for it
      autoFocus
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(value);
        if (event.key === 'Escape') finish(null);
      }}
      onBlur={() => {
        finish(value);
      }}
    />
  );
}

interface TabProps {
  readonly chat: AssistantChat;
  readonly current: boolean;
  readonly editing: boolean;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onSelect: (key: string) => void;
  readonly onEdit: () => void;
  readonly onRenamed: (title: string | null) => void;
  readonly onKey: (event: KeyboardEvent) => void;
  readonly onTakeOut: (key: string) => void;
}

function Tab(props: TabProps): ReactElement {
  const { chat } = props;
  return (
    <span className="aip__tab">
      {props.editing ? (
        <Renaming chat={chat} onDone={props.onRenamed} />
      ) : (
        <button
          ref={props.register}
          className="cmtab"
          type="button"
          role="tab"
          data-chat={chat.key}
          aria-selected={props.current}
          tabIndex={props.current ? 0 : -1}
          title={`${chat.title} — double-click to rename`}
          onClick={() => {
            props.onSelect(chat.key);
          }}
          onDoubleClick={props.onEdit}
          onKeyDown={props.onKey}
        >
          {chat.title}
        </button>
      )}
      <button
        className="aip__tabx"
        type="button"
        data-chat-close={chat.key}
        aria-label={`Close ${chat.title}`}
        onClick={() => {
          props.onTakeOut(chat.key);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}

/** Roving focus over the tabs: the move selects, and focus follows it. */
function useRoving(
  chats: readonly AssistantChat[],
  onSelect: (key: string) => void,
): {
  readonly register: (key: string) => (element: HTMLButtonElement | null) => void;
  readonly keyed: (event: KeyboardEvent, at: number) => void;
} {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  return {
    register: (key) => (element) => {
      if (element === null) tabs.current.delete(key);
      else tabs.current.set(key, element);
    },
    keyed: (event, at) => {
      const move = MOVES[event.key];
      if (move === undefined || chats.length === 0) return;
      event.preventDefault();
      const next = chats[move(at, chats.length)];
      if (next === undefined) return;
      onSelect(next.key);
      tabs.current.get(next.key)?.focus();
    },
  };
}

export function TabRow(props: TabRowProps): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const { register, keyed } = useRoving(props.chats, props.onSelect);
  const renamed = (chat: AssistantChat, title: string | null): void => {
    setEditing(null);
    const trimmed = title?.trim() ?? '';
    if (trimmed !== '' && trimmed !== chat.title) props.onRename(chat.key, trimmed);
  };
  return (
    <div className="aip__tabs cmtabs" role="tablist" aria-label="Conversations">
      {props.chats.map((chat, at) => (
        <Tab
          key={chat.key}
          chat={chat}
          current={chat.key === props.selected}
          editing={editing === chat.key}
          register={register(chat.key)}
          onSelect={props.onSelect}
          onEdit={() => {
            setEditing(chat.key);
          }}
          onRenamed={(title) => {
            renamed(chat, title);
          }}
          onKey={(event) => {
            keyed(event, at);
          }}
          onTakeOut={props.onTakeOut}
        />
      ))}
      <button
        className="aip__new"
        type="button"
        data-assistant="new"
        aria-label="New conversation"
        title="New conversation"
        onClick={() => {
          props.onNew();
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

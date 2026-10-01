// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's conversation, direct (C71-D) or group (C71-G): the thread
// in the task thread's dialect and the composer. A click into the thread reads
// it; a send moves the sender's marker in the comment command's own
// transaction (R36).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { TeamConversation, TeamMessage } from '../state/team.ts';

const stamp = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function Message(props: { readonly message: TeamMessage; readonly me: string }): ReactElement {
  const { message } = props;
  return (
    <div className="msg" data-message={message.id}>
      <div className="msg__meta">
        <b>{message.authorId === props.me ? 'You' : message.author}</b>{' '}
        <time className="msg__at" dateTime={message.at}>
          {stamp.format(new Date(message.at))}
        </time>
      </div>
      <p className="msg__text">{message.body}</p>
    </div>
  );
}

function Composer(props: {
  readonly to: string;
  readonly onSend: (body: string) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const label = `Message ${props.to}`;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const said = text.trim();
        if (said === '') return;
        props.onSend(said);
        setText('');
        field.current?.focus();
      }}
    >
      <input
        ref={field}
        placeholder={label}
        aria-label={label}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button type="submit" className="btn btn--primary btn--sm">
        Send
      </button>
    </form>
  );
}

export function Conversation(props: {
  /** The conversation's key: a teammate's person id or a group's id. */
  readonly id: string;
  /** Whom the composer says it messages: the teammate's short name or the group's name. */
  readonly to: string;
  readonly thread: TeamConversation | undefined;
  readonly me: string;
  readonly onRead: () => void;
  readonly onSend: (body: string) => void;
}): ReactElement {
  const messages = props.thread?.messages ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  // To the end of the scroller, never to a measured message position.
  useEffect(() => {
    const box = scroller.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [messages.length, props.id]);
  return (
    <>
      {/* A click into the conversation reads it; by keyboard the face and the composer do. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="tmc__scroll" ref={scroller} onClick={props.onRead}>
        <div className="thread">
          {messages.map((message) => (
            <Message key={message.id} message={message} me={props.me} />
          ))}
        </div>
      </div>
      <Composer key={props.id} to={props.to} onSend={props.onSend} />
    </>
  );
}

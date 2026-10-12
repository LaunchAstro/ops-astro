// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's conversation, direct (C71-D) or group (C71-G): the thread
// in the task thread's dialect and the composer. A click into the thread reads
// it; a send moves the sender's marker in the comment command's own
// transaction (R36).

import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
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

/** Resolves true once the server took the words; false hands them back to the composer. */
type Send = (body: string) => Promise<boolean>;

/** Words the server did not take while newer ones were already typed, and the door to put them back. */
function Unsent(props: { readonly words: string; readonly onPutBack: () => void }): ReactElement {
  return (
    <p className="field__error" role="alert" data-composer-unsent="">
      Not sent: {props.words}{' '}
      <button type="button" className="btn btn--ghost btn--sm" onClick={props.onPutBack}>
        Put it back
      </button>
    </p>
  );
}

interface Kept {
  readonly send: number;
  readonly words: string;
}

/** Each refused send kept beside newer words, its own entry by the send that made it. */
function useUnsent(typed: RefObject<string>, setText: (text: string) => void) {
  const [list, setList] = useState<readonly Kept[]>([]);
  return {
    list,
    keep: (send: number, words: string) => setList((now) => [...now, { send, words }]),
    putBack: (one: Kept) => {
      setText(`${one.words} ${typed.current}`.trim());
      setList((now) => now.filter((each) => each.send !== one.send));
    },
  };
}

function Composer(props: { readonly to: string; readonly onSend: Send }): ReactElement {
  const [text, setText] = useState('');
  const typed = useRef('');
  typed.current = text;
  const unsent = useUnsent(typed, setText);
  const sends = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const label = `Message ${props.to}`;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const said = text.trim();
        if (said === '') return;
        sends.current += 1;
        const send = sends.current;
        setText('');
        field.current?.focus();
        // Words the server did not take go back in, or beside newer ones the person has started.
        void props.onSend(said).then((sent) => {
          if (sent) return sent;
          if (typed.current === '') setText(said);
          else unsent.keep(send, said);
          return sent;
        });
      }}
    >
      {unsent.list.map((one) => (
        <Unsent key={one.send} words={one.words} onPutBack={() => unsent.putBack(one)} />
      ))}
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
  /** Null where the reader keeps no read marker: a group they have left. */
  readonly onRead: (() => void) | null;
  /** Null where the reader may not send: a group they have left. */
  readonly onSend: Send | null;
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
      <div className="tmc__scroll" ref={scroller} onClick={props.onRead ?? undefined}>
        <div className="thread">
          {messages.map((message) => (
            <Message key={message.id} message={message} me={props.me} />
          ))}
        </div>
      </div>
      {props.onSend === null ? null : (
        <Composer key={props.id} to={props.to} onSend={props.onSend} />
      )}
    </>
  );
}

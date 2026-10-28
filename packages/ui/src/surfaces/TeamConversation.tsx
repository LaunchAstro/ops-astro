// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's conversation, direct (C71-D) or group (C71-G): the thread
// in the task thread's dialect and the composer. A click into the thread reads
// it; a send moves the sender's marker in the comment command's own
// transaction (R36). Words the server has not taken wait between the two
// (#1339). A send with no answer also comes back into the composer, if it is
// still empty, and sending those words unchanged resends them under their
// first operation id. Edit moves refused words back only into an empty
// composer, and they stay kept until the words in the box are sent.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { TeamConversation, TeamMessage, Unsent } from '../state/team.ts';

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

/** A conversation's unsent words and what the reader may do with them. */
export interface Waiting {
  readonly unsent: readonly Unsent[];
  readonly onResend: (id: string) => void;
  readonly onDiscard: (id: string) => void;
}

const SAID: Readonly<Record<Unsent['state'], string>> = {
  sending: 'Sending…',
  refused: 'Not sent: refused.',
  unanswered: 'Not sent: no answer yet.',
};

/** `edit` is null where nothing can be written: a group the reader has left. */
function UnsentList(props: {
  readonly waiting: Waiting;
  readonly edit: { readonly open: boolean; readonly take: (one: Unsent) => void } | null;
}): ReactElement | null {
  const { unsent, onResend, onDiscard } = props.waiting;
  const { edit } = props;
  if (unsent.length === 0) return null;
  return (
    <ul className="tmc__unsent" aria-label="Not sent">
      {unsent.map((one) => (
        <li key={one.id} data-unsent={one.state}>
          <p data-unsent-words>{one.body}</p>
          <span className="tmc__why">{SAID[one.state]}</span>
          {one.state === 'unanswered' ? (
            <button
              type="button"
              className="btn btn--sm"
              data-unsent-resend
              onClick={() => onResend(one.id)}
            >
              Resend
            </button>
          ) : null}
          {one.state === 'refused' && edit !== null ? (
            <button
              type="button"
              className="btn btn--sm"
              data-unsent-edit
              disabled={!edit.open}
              onClick={() => edit.take(one)}
            >
              Edit
            </button>
          ) : null}
          {one.state === 'sending' ? null : (
            <button
              type="button"
              className="btn btn--sm"
              data-unsent-discard
              onClick={() => onDiscard(one.id)}
            >
              Discard
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The words this composer last sent, and the unsent entries already there when it did. */
interface Sent {
  readonly said: string;
  readonly before: ReadonlySet<string>;
}

/**
 * The composer's box and the unsent entry it holds: a send of its own with no
 * answer, or refused words taken back by Edit.
 */
function useBox(waiting: Waiting, onSend: (body: string) => void) {
  const [text, setText] = useState('');
  const [held, setHeld] = useState<Pick<Unsent, 'id' | 'body'> | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const { unsent, onResend, onDiscard } = waiting;
  // The held entry as the outbox has it now: its state moves on after a Resend.
  const now = held === null ? undefined : unsent.find((one) => one.id === held.id);
  useEffect(() => {
    const mine =
      sent === null
        ? undefined
        : unsent.find((one) => one.body === sent.said && !sent.before.has(one.id));
    if (mine !== undefined && mine.state !== 'sending') {
      setSent(null);
      if (mine.state === 'unanswered' && text === '') {
        setText(mine.body);
        setHeld(mine);
      }
    }
    // Refused words emptied out of the box go back to the list, Edit and all.
    if (now?.state === 'refused' && text === '') setHeld(null);
    if (held !== null && now === undefined) {
      setHeld(null);
      if (text === held.body) setText('');
    }
  }, [unsent, sent, held, now, text]);
  const take = (one: Unsent): void => {
    setText(one.body);
    setHeld(one);
  };
  const send = (said: string): void => {
    if ((now?.state === 'unanswered' || now?.state === 'sending') && said === now.body) {
      onResend(now.id);
      return;
    }
    if (now?.state === 'refused') onDiscard(now.id);
    setHeld(null);
    setSent({ said, before: new Set(unsent.map((one) => one.id)) });
    onSend(said);
    setText('');
  };
  const shown = unsent.filter((one) => one.id !== now?.id || one.state !== 'refused');
  return { text, setText, take, send, shown };
}

function Composer(props: {
  readonly to: string;
  readonly onSend: (body: string) => void;
  readonly waiting: Waiting;
}): ReactElement {
  const { text, setText, take, send, shown } = useBox(props.waiting, props.onSend);
  const field = useRef<HTMLInputElement>(null);
  const label = `Message ${props.to}`;
  const edit = (one: Unsent): void => {
    if (text !== '') return;
    take(one);
    field.current?.focus();
  };
  return (
    <>
      <UnsentList
        waiting={{ ...props.waiting, unsent: shown }}
        edit={{ open: text === '', take: edit }}
      />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const said = text.trim();
          if (said === '') return;
          send(said);
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
    </>
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
  readonly onSend: ((body: string) => void) | null;
  readonly waiting: Waiting;
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
      {props.onSend === null ? (
        <UnsentList waiting={props.waiting} edit={null} />
      ) : (
        <Composer key={props.id} to={props.to} onSend={props.onSend} waiting={props.waiting} />
      )}
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// C36: a conversation at its own address (CS-7.38). While the body lives it
// is the transcript; once the body has purged it is the wrap-up and never a
// transcript: the request as a marked quotation, each item's fact and its
// pointers, and what was left open. Every body and fact is drawn as text; a
// pointer is a link only to an address inside this product (`ownHref`), and
// anything else is named, never linked.

import type { ReactElement } from 'react';
import { ownHref } from './assistant/transcript.tsx';

export interface ConversationRecordMessage {
  readonly id: string;
  readonly role: 'person' | 'agent';
  readonly body: string;
}

export interface ConversationRecordPointer {
  readonly kind: string;
  readonly id: string;
  readonly address: string;
  readonly state?: string;
}

export interface ConversationRecordWrapUp {
  readonly request: string;
  readonly items: readonly {
    readonly key: string;
    readonly fact: string;
    readonly pointers: readonly ConversationRecordPointer[];
  }[];
  readonly leftOpenText: string;
}

export interface ConversationRecordProps {
  readonly title: string;
  readonly subject: string | null;
  /** The body, or null once it has purged. */
  readonly messages: readonly ConversationRecordMessage[] | null;
  readonly wrapUp: ConversationRecordWrapUp | null;
}

const ROLE = { person: 'You', agent: 'Agent' } as const;
// Each message in the drawer's own message look (DS-COMP-23's panel, MP-7-11),
// so a conversation reads the same at its address as in the dock.
const BUBBLE = { person: 'aip__msg--user', agent: 'aip__msg--ai' } as const;

function Pointer(props: { readonly pointer: ConversationRecordPointer }): ReactElement {
  const { pointer } = props;
  const words = `${pointer.kind} ${pointer.address}${pointer.state === undefined ? '' : ` (${pointer.state})`}`;
  return <li>{ownHref(pointer.address) ? <a href={pointer.address}>{words}</a> : words}</li>;
}

function WrapUp(props: { readonly wrapUp: ConversationRecordWrapUp }): ReactElement {
  return (
    <section className="convrec__wrap" data-conversation="wrap-up" aria-label="Wrap-up">
      <p className="convrec__note">
        The conversation’s body has been cleared. This is its wrap-up.
      </p>
      <blockquote className="convrec__request" data-conversation="request">
        {props.wrapUp.request}
      </blockquote>
      <dl className="convrec__items">
        {props.wrapUp.items.map((item) => (
          <div key={item.key}>
            <dt>{item.fact}</dt>
            {item.pointers.length === 0 ? null : (
              <dd>
                <ul>
                  {item.pointers.map((pointer) => (
                    <Pointer key={`${pointer.kind} ${pointer.id}`} pointer={pointer} />
                  ))}
                </ul>
              </dd>
            )}
          </div>
        ))}
      </dl>
      <p className="convrec__open" data-conversation="left-open">
        {props.wrapUp.leftOpenText}
      </p>
    </section>
  );
}

export function ConversationRecord(props: ConversationRecordProps): ReactElement {
  return (
    <article className="convrec">
      <header className="convrec__head">
        <h1 data-conversation="title">{props.title}</h1>
        {props.subject === null ? null : <p className="convrec__subject">{props.subject}</p>}
      </header>
      {props.messages === null ? (
        props.wrapUp === null ? (
          <p className="convrec__note">This conversation’s body has been cleared.</p>
        ) : (
          <WrapUp wrapUp={props.wrapUp} />
        )
      ) : (
        <ol className="convrec__log" data-conversation="transcript" aria-label="Conversation">
          {props.messages.map((message) => (
            <li
              key={message.id}
              className={`aip__msg ${BUBBLE[message.role]} convrec__msg convrec__msg--${message.role}`}
            >
              <span className="convrec__who">{ROLE[message.role]}</span>
              <p data-conversation="message">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

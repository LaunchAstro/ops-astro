// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the transcript (AI-09), with each answer's citations under it.
//
// **Every answer cites what it read** (AI-11, AI-12): each record an answer
// drew on is listed under it. A citation is a link only when its address is
// one of the product's own, a path from the root; anything else, a scheme, a
// host or a protocol-relative `//`, is shown as words and never as a link,
// because a citation is text a model produced and a link is a door the asker
// walks through. Every body is text: nothing a model or a person wrote is
// read as markup.

import type { ReactElement } from 'react';
import type { AssistantCite, AssistantMessage } from '../AssistantPanel.tsx';

/** A path inside the product: one leading slash, then no slash or backslash, no space or control. */
export const ownHref = (href: string): boolean =>
  /^\/(?![/\\])[^\s\\]*$/u.test(href) && !/\p{Cc}/u.test(href);

const ROLE_CLASS = {
  user: 'aip__msg--user',
  ai: 'aip__msg--ai',
  note: 'aip__msg--note',
  failed: 'aip__msg--note aip__msg--failed',
} as const satisfies Record<AssistantMessage['role'], string>;

function Cites(props: { readonly cites: readonly AssistantCite[] }): ReactElement {
  return (
    <ul className="aip__cites" data-cites="" aria-label="What this answer read">
      {props.cites.map((cite, at) => (
        // Two records may share a label; the position is the stable key.
        // oxlint-disable-next-line react/no-array-index-key -- the list is never reordered
        <li key={at}>{ownHref(cite.href) ? <a href={cite.href}>{cite.label}</a> : cite.label}</li>
      ))}
    </ul>
  );
}

export function Transcript(props: {
  readonly messages: readonly AssistantMessage[];
}): ReactElement {
  return (
    <div className="aip__scroll" role="log" aria-live="polite" aria-label="Conversation">
      {props.messages.map((message) => (
        <div
          key={message.id}
          className={`aip__msg ${ROLE_CLASS[message.role]}`}
          data-message-role={message.role}
        >
          {message.body}
          {message.role === 'ai' && message.cites.length > 0 ? (
            <Cites cites={message.cites} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

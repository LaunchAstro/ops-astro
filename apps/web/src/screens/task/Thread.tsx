// SPDX-License-Identifier: AGPL-3.0-only
//
// One tab's thread on the task page: messages in time order, each with its
// replies one level under it (MP-4-5, R42).
//
// **A reply is drawn under its message, wherever it arrived in the list.** The
// read sends every comment flat, each reply naming its `parent`; the thread is
// built from those names (`thread-shape.ts`), so a reply on the third message
// is as present as one on the first. A reply whose message is not in the list
// had its message deleted: the replies stay, under a line saying so, because
// deleting your words does not take back what others answered.
//
// **The pencil and the × are on the reader's own rows only** (DT-17, CS-4.34),
// as the read marks them. The commands check the author again whatever the
// screen draws. Editing: Esc puts the old words back, Ctrl or Cmd and Enter or
// leaving the box stores the new ones, and an emptied box keeps the old words
// (the × is how words are taken back). The box stays open, busy, until the
// answer, and only a stored edit closes it; its words are held above the read
// as typed, so a remount or a refusal keeps them. The × deletes by its id.
//
// **Where a client message stands is a label, never a control** (DT-19, R56):
// Reply owed, Not acknowledged or Answered, with a title saying what it means.
// Seen waits on the portal's read receipt.

import type { ReactElement } from 'react';
import { EditBox } from './CommentEditBox.tsx';
import { Empty } from '@launchastro/ui';
import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';
import { editOf, parentOf, threadOf, type RowEdit } from './thread-shape.ts';

export type { RowEdit };

/** What a row can ask of the conversation around it. */
export interface RowActions {
  readonly authors?: ReadonlyMap<string, string>;
  readonly onReply: (commentId: string) => void;
  readonly onEdit: (comment: InternalCommentView, body: string) => void;
  readonly onDelete: (commentId: string) => void;
  /** The edit open on a row, or null; opened, and closed without a write, here. */
  readonly editing: RowEdit | null;
  readonly onEditing: (edit: RowEdit | null) => void;
  /** A write is in flight: no row starts another. */
  readonly busy: boolean;
}

export function CommentThread(props: {
  readonly comments: readonly InternalCommentView[];
  readonly empty: string;
  readonly actions: RowActions;
}): ReactElement {
  const messages = threadOf(props.comments);
  return messages.length === 0 ? (
    <Empty look="inline" title={props.empty} />
  ) : (
    <div className="thread" data-comments="list">
      {messages.map((message) =>
        message.comment === null ? (
          <article className="msg msg--deleted" data-comment-deleted="" key={message.id}>
            <p className="card__body">This message was deleted.</p>
            <Replies replies={message.replies} actions={props.actions} />
          </article>
        ) : (
          <Row comment={message.comment} actions={props.actions} key={message.id}>
            <Replies replies={message.replies} actions={props.actions} />
          </Row>
        ),
      )}
    </div>
  );
}

function Replies(props: {
  readonly replies: readonly InternalCommentView[];
  readonly actions: RowActions;
}): ReactElement | null {
  return props.replies.length === 0 ? null : (
    <div className="msg__replies" data-replies="">
      {props.replies.map((reply) => (
        <Row comment={reply} actions={props.actions} key={reply.id} />
      ))}
    </div>
  );
}

/** One message or reply: who may read it, its words, and what the reader may do. */
function Row(props: {
  readonly comment: InternalCommentView;
  readonly actions: RowActions;
  readonly children?: ReactElement;
}): ReactElement {
  const { comment, actions } = props;
  const edit = actions.editing?.commentId === comment.id ? actions.editing : null;
  const isReply = parentOf(comment) !== null;
  const author =
    actions.authors?.get(comment.author) ??
    (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(comment.author) ? 'Someone' : comment.author);
  return (
    <article
      className={`msg msg--${comment.audience}`}
      data-comment-id={comment.id}
      data-audience={comment.audience}
    >
      <MessageAvatar author={author} />
      <div className="msg__body">
        <RowMeta comment={comment} author={author} />
        {edit === null ? (
          <p className="card__body">{comment.body}</p>
        ) : (
          <EditBox
            saved={comment.body}
            body={edit.body}
            busy={actions.busy}
            onText={(body) => actions.onEditing({ ...edit, body })}
            onDone={(next) => {
              if (next === null) actions.onEditing(null);
              else actions.onEdit(comment, next);
            }}
          />
        )}
        <RowActs
          comment={comment}
          reply={isReply}
          editing={edit !== null}
          actions={actions}
          onEditing={() => {
            actions.onEditing(editOf(comment));
          }}
        />
        {props.children}
      </div>
    </article>
  );
}

/** Who may read a row, what it is, who wrote it and when, and a client message's signal. */
function RowMeta(props: {
  readonly comment: InternalCommentView;
  readonly author: string;
}): ReactElement {
  return (
    <div className="msg__meta" title={props.comment.comment_type}>
      <b>{props.author}</b>
      <time className="msg__at" dateTime={props.comment.posted_at} title={props.comment.posted_at}>
        {new Date(props.comment.posted_at).toLocaleString('en-AU', {
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'Australia/Brisbane',
        })}
        {props.comment.edited_at === null ? '' : ' · edited'}
      </time>
      <span className="msg__audience" data-comment-audience={props.comment.audience}>
        {audienceWord(props.comment.audience)}
      </span>
      <Signal signal={props.comment.signal ?? null} />
    </div>
  );
}

/** Reply on a message; the pencil and the × on the reader's own rows. */
function RowActs(props: {
  readonly comment: InternalCommentView;
  readonly reply: boolean;
  readonly editing: boolean;
  readonly actions: RowActions;
  readonly onEditing: () => void;
}): ReactElement {
  return (
    <div className="msg__acts">
      {props.reply ? null : (
        <Act
          act="reply"
          busy={props.actions.busy}
          onPress={() => props.actions.onReply(props.comment.id)}
        >
          Reply
        </Act>
      )}
      {props.comment.own === true && !props.editing ? (
        <>
          <Act
            act="edit"
            name="Edit your message"
            busy={props.actions.busy}
            onPress={props.onEditing}
          >
            ✎
          </Act>
          <Act
            act="delete"
            name="Delete your message"
            busy={props.actions.busy}
            onPress={() => props.actions.onDelete(props.comment.id)}
          >
            ×
          </Act>
        </>
      ) : null}
    </div>
  );
}

/** One row control; a glyph gets its name spoken and shown on hover. */
function Act(props: {
  readonly act: string;
  readonly name?: string;
  readonly busy: boolean;
  readonly onPress: () => void;
  readonly children: string;
}): ReactElement {
  return (
    <button
      type="button"
      className="btn btn--ghost"
      data-comment-act={props.act}
      aria-label={props.name}
      title={props.name}
      disabled={props.busy}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/**
 * The box a row's words are edited in, showing `body` and handing each
 * keystroke up. It hands back the new words, or null when nothing is to be
 * stored: Esc, words the same as the stored ones (`saved`), or an emptied box.
 */
const SIGNALS: Readonly<Record<string, { word: string; title: string }>> = {
  owed: { word: 'Reply owed', title: 'The client is waiting on a reply from the team.' },
  not_acknowledged: {
    word: 'Not acknowledged',
    title: 'Nobody on the client’s side has replied to this yet.',
  },
  answered: { word: 'Answered', title: 'The client and the team have each had their say.' },
};

function Signal(props: { readonly signal: string | null }): ReactElement | null {
  const shown = props.signal === null ? undefined : SIGNALS[props.signal];
  return shown === undefined ? null : (
    <>
      <span> · </span>
      <span className="msg__signal" data-signal={props.signal} title={shown.title}>
        {shown.word}
      </span>
    </>
  );
}

/** The audience in the words a person reads, and the server's own word kept. */
function audienceWord(audience: string): string {
  if (audience === 'internal') return 'Internal';
  if (audience === 'client') return 'Client';
  // A word this build does not know is printed as it arrived. Inventing a
  // label for it would hide the fact that something new is being stored.
  return audience;
}

function MessageAvatar(props: { readonly author: string }): ReactElement {
  return (
    <span className="msg__avatar" aria-hidden="true">
      {props.author
        .trim()
        .split(/\s+/u)
        .map((part) => part[0])
        .slice(0, 2)
        .join('')}
    </span>
  );
}

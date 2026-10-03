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

import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';
import { parentOf, threadOf } from './thread-shape.ts';

/** The row being edited: its words as typed, and why they were refused. */
export interface RowEdit {
  readonly commentId: string;
  readonly body: string;
  readonly because: string | null;
}

/** What a row can ask of the conversation around it. */
export interface RowActions {
  readonly onReply: (commentId: string) => void;
  readonly onEdit: (commentId: string, body: string) => void;
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
  return (
    <article
      className={`msg msg--${comment.audience}`}
      data-comment-id={comment.id}
      data-audience={comment.audience}
    >
      <RowMeta comment={comment} />
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
            else actions.onEdit(comment.id, next);
          }}
        />
      )}
      <RowActs
        comment={comment}
        reply={isReply}
        editing={edit !== null}
        actions={actions}
        onEditing={() => {
          actions.onEditing({ commentId: comment.id, body: comment.body, because: null });
        }}
      />
      {props.children}
    </article>
  );
}

/** Who may read a row, what it is, who wrote it and when, and a client message's signal. */
function RowMeta(props: { readonly comment: InternalCommentView }): ReactElement {
  return (
    <div className="sbact__meta">
      {/* The audience is drawn on every comment, because "who may read
            this" is the one thing a person writing the next one needs to
            know and the one thing a colour cannot say. */}
      <span className="sb__state" data-comment-audience={props.comment.audience}>
        {audienceWord(props.comment.audience)}
      </span>
      <span> · {props.comment.comment_type}</span>
      <span> · {props.comment.author}</span>
      <span> · {props.comment.posted_at}</span>
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
function EditBox(props: {
  readonly saved: string;
  readonly body: string;
  readonly busy: boolean;
  readonly onText: (body: string) => void;
  readonly onDone: (next: string | null) => void;
}): ReactElement {
  // Esc or a commit ends the edit once; the blur that can follow the box
  // leaving the page must not end it a second time. A refusal reopens it.
  const ended = useRef(false);
  useEffect(() => {
    if (!props.busy) ended.current = false;
  }, [props.busy]);
  const end = (next: string | null): void => {
    if (ended.current || props.busy) return;
    ended.current = true;
    props.onDone(next === null || next.trim() === '' || next === props.saved ? null : next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      end(null);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      end(props.body);
    }
  };
  return (
    <textarea
      className="input"
      aria-label="Edit your message"
      data-comment-edit=""
      rows={3}
      readOnly={props.busy}
      aria-busy={props.busy}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the pencil was pressed to write here
      autoFocus
      value={props.body}
      onKeyDown={onKeyDown}
      onBlur={() => {
        end(props.body);
      }}
      onChange={(event) => {
        props.onText(event.target.value);
      }}
    />
  );
}

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

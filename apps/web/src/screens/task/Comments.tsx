// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's comments: the server's list, and a box to add to it.
//
// **Comments are the server's list, and the screen never adds to it.** A post
// goes out through `task.comment` and the list is reread from `task.read`; a
// screen that appended the comment it had just sent would be drawing a row that
// may never have been stored. The write leaves the task's own revision alone.
//
// **A refused comment is asked once.** There is no grant read anywhere in this
// build, so the box cannot know whether a person holds `comment` before it
// asks. It asks once, quotes the server's own code, and then stops offering a
// control that has already been refused for this reader. The refusal is held
// above the read (`TaskDetail.tsx`), because any reread of the task remounts
// this box, and a closure that lasted only until the next reread would invite
// the same refusal again after an unrelated write.
//
// **A comment whose answer was lost is sent again as the same attempt.** The
// server may have stored it, and `task.comment` leaves the revision alone, so
// only the `operationId` tells the register that the retry of an unchanged box
// is the comment it already has. The retry resends the revision the attempt was
// first sent at, not the one the page now shows: the register compares every
// field but the identity, so a retry carrying a newer revision after a reread
// would be refused `OPERATION_ID_REUSED` rather than replayed. If the first
// attempt was never stored, that old revision is the server's `VERSION_STALE`,
// which the stale path below handles. Changing the text, the audience or the
// kind is a different comment and gets a new one.
//
// **The conversation is three tabs** (MP-4-5, DT-14, DT-21): Internal and
// Client with their counts, and All activity with none. It opens on Internal
// on the page and the panel alike (R41). The tab is the audience: Internal
// posts a note the business reads, Client a client message the client reads,
// and on All the box is closed with a line saying to pick one, so nothing is
// posted to an audience nobody chose. There is no kind to choose, so the
// `system` kind a product writes about itself is never offered. Each tab reads
// in time order. Enter sends; Shift and Enter is a new line.
//
// **What the person typed is held above the read** (`TaskDetail.tsx`), with
// the attempt, because every reread of the task remounts this box. A comment
// refused `VERSION_STALE` rereads the task, keeps the text, and quotes the
// refusal, so the next press goes out against the revision the page now shows.
// `task.comment` leaves the revision alone, so there is nothing to merge.
//
// **A reply is the same box, pointed at one message** (R42). Pressing Reply on
// a message holds its id with the draft; the post then carries `parentId` and
// goes to that message's audience, whichever tab is showing, since the message
// already says who may read what answers it. The thread itself, the pencil and
// the ×, and the signals are drawn by `Thread.tsx`; an edit or a delete goes
// out through its own command and the task is read again, as a post is.

import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import { CountBadge, TabPanel, TabStrip } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { PanelDoorButton, type PanelDoor } from './Perspectives.tsx';
import { CommentThread, type RowActions } from './Thread.tsx';

export interface CommentsProps {
  readonly client: OperationsClient;
  /**
   * An internal reader's comments, every field present. The shared projection
   * is drawn by `SharedTaskDetail.tsx`, which never mounts this box.
   */
  readonly comments: readonly InternalCommentView[];
  readonly recordId: string;
  /** The revision the comment is written against. `task.comment` does not move it. */
  readonly revision: number;
  /** An earlier refusal on this reader's authority, which outlives the reread. */
  readonly refusal: string | null;
  readonly onRefused: (because: string) => void;
  readonly onPosted: () => void;
  /** The dock task panel's opener, for the reply door (MP-4-8 wires it). */
  readonly onOpenPanel?: ((door: PanelDoor) => void) | undefined;
  /** The unsent comment, held above the read so a reread keeps it. Null is an empty box. */
  readonly draft: CommentDraft | null;
  readonly onDraft: (next: CommentDraft | null) => void;
}

/** An unsent comment: the words, the attempt whose outcome is unknown, and a stale refusal. */
export interface CommentDraft {
  readonly body: string;
  /** The tab showing, which is also the audience a post goes to. */
  readonly tab: ConversationTab;
  /** The message this is a reply to, or null for a new message. */
  readonly replyTo: string | null;
  readonly pending: PendingComment | null;
  /** The server's `VERSION_STALE`, quoted across the reread it caused. */
  readonly stale: string | null;
}

const EMPTY: CommentDraft = {
  body: '',
  tab: 'internal',
  replyTo: null,
  pending: null,
  stale: null,
};

export type ConversationTab = 'internal' | 'client' | 'all';

/** What a post from each writable tab is: who may read it, and what it is. */
const POSTS: Readonly<Record<'internal' | 'client', { audience: string; kind: string }>> = {
  internal: { audience: 'internal', kind: 'note' },
  client: { audience: 'client', kind: 'client' },
};

/** A comment whose outcome is not known, held so the retry is the same attempt. */
export interface PendingComment {
  readonly operationId: string;
  /** The revision the attempt was sent at, resent with it so the register replays. */
  readonly revision: number;
  readonly body: string;
  readonly audience: string;
  readonly kind: string;
  readonly parentId: string | null;
}

export function Comments(props: CommentsProps): ReactElement {
  const current = props.draft ?? EMPTY;
  const { body, tab, pending } = current;
  // A reply names a message still on the task; one deleted since is dropped.
  const parent = props.comments.find(
    (comment) => comment.id === current.replyTo && (comment.parent ?? null) === null,
  );
  const parentId = parent?.id ?? null;
  const { audience, kind } = POSTS[(parent?.audience ?? tab) === 'client' ? 'client' : 'internal'];
  const put = (next: Partial<CommentDraft>): void => {
    props.onDraft({ ...current, ...next });
  };
  const same = (attempt: PendingComment | null): attempt is PendingComment =>
    attempt !== null &&
    attempt.body === body &&
    attempt.audience === audience &&
    attempt.kind === kind &&
    attempt.parentId === parentId;
  // `closed` is set when the server has said this reader may not comment. It
  // disables the control rather than merely reporting, so the same refusal is
  // not fetched again on the next press. Only an authority refusal closes the
  // form: a body the server did not like is something the person can fix and
  // try again. A refusal held above the read closes it the same way.
  const command = useCommand();
  const busy = command.busy;
  const closed = command.closed || props.refusal !== null;
  // On All nobody has said who may read a post, so there is nothing to post,
  // unless it is a reply, which goes where its message is.
  const picking = tab === 'all' && parentId === null;
  const locked = busy || closed || picking;
  const rows = useRowActions(props, (commentId) => {
    put({ replyTo: commentId, pending: null });
  });
  const because = command.because ?? props.refusal;
  const run = command.run;
  const form = useRef<HTMLFormElement>(null);

  const post = (): void => {
    if (locked) return;
    if (form.current?.reportValidity() === false) return;
    const attempt = same(pending)
      ? pending
      : {
          operationId: props.client.newOperationId(),
          revision: props.revision,
          body,
          audience,
          kind,
          parentId,
        };
    put({ pending: attempt, stale: null });
    run(
      () =>
        props.client.mutate(
          'task.comment',
          {
            recordId: props.recordId,
            body,
            audience,
            commentType: kind,
            ...(parentId === null ? {} : { parentId }),
          },
          { expectedRevision: attempt.revision, operationId: attempt.operationId },
        ),
      (settlement) => {
        // An unknown outcome keeps the attempt; any answer from the server ends it.
        if (settlement.kind === 'unknown') return;
        if (settlement.kind === 'closed') props.onRefused(settlement.because);
        if (settlement.kind === 'stale') {
          // The task moved on. Keep the words, read the task again, and say why.
          props.onDraft({ ...current, pending: null, stale: settlement.because });
          props.onPosted();
          return;
        }
        if (settlement.kind !== 'ok') {
          props.onDraft({ ...current, pending: null, stale: null });
          return;
        }
        // Emptied because it has been stored, and the list is reread rather
        // than appended to: what is on the screen is what the server has. The
        // tab stays where the person posted from.
        props.onDraft({ ...EMPTY, tab });
        props.onPosted();
      },
    );
  };

  return (
    <section className="sb__sect" data-comments="section">
      <div className="sb__sh">
        <span className="sb__k">Comments</span>
        <span className="sbact__meta">{props.comments.length} on this task</span>
      </div>

      <Conversation
        comments={props.comments}
        tab={tab}
        actions={rows.actions}
        onTab={(next) => {
          put({ tab: next });
        }}
      />
      {rows.because === null ? null : (
        <p className="field__error" role="alert" data-comment="row-refusal">
          {rows.because}
        </p>
      )}

      <PostNotices because={because} stale={current.stale} unresolved={!busy && same(pending)} />

      <form
        id="task-comment"
        className="taskform"
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          post();
        }}
      >
        {parent === undefined ? null : (
          <ReplyingTo
            body={parent.body}
            onCancel={() => {
              put({ replyTo: null, pending: null });
            }}
          />
        )}
        <CommentBody body={body} locked={locked} onPut={put} onSend={post} />
        {picking ? (
          <p className="card__sub" data-comment="pick">
            Pick Internal or Client to post, so it is clear who may read it.
          </p>
        ) : null}
        <button className="btn btn--primary" type="submit" data-comment="post" disabled={locked}>
          {busy ? 'Posting…' : 'Post comment'}
        </button>
        {!closed ? null : (
          <p className="card__sub" data-comment="closed">
            The server refused this. The box is closed rather than asking again on your behalf.
          </p>
        )}
      </form>
      <PanelDoorButton door="reply" onOpenPanel={props.onOpenPanel} />
    </section>
  );
}

/** Why the last post did not land, or may have. */
function PostNotices(props: {
  readonly because: string | null;
  readonly stale: string | null;
  readonly unresolved: boolean;
}): ReactElement {
  return (
    <>
      {props.because === null ? null : (
        <p className="field__error" role="alert" data-comment="refusal">
          {props.because}
        </p>
      )}
      {props.stale === null ? null : (
        <div role="alert" data-comment="stale">
          <p className="field__error">{props.stale}</p>
          <p className="card__sub">
            Somebody else moved this task on before your comment was stored, so it was not. The task
            has been read again and your comment is still here: post it again if it still applies.
          </p>
        </div>
      )}
      {props.unresolved ? (
        <p className="card__sub" data-comment="unresolved">
          This comment may already have been stored. Posting again sends the same attempt, so the
          server answers with the original result rather than storing it twice.
        </p>
      ) : null}
    </>
  );
}

/** Which message the box is replying to, and a way out of replying. */
function ReplyingTo(props: { readonly body: string; readonly onCancel: () => void }): ReactElement {
  return (
    <p className="card__sub" data-comment="replying">
      Replying to “{excerpt(props.body)}”{' '}
      <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
        Cancel reply
      </button>
    </p>
  );
}

const TAB_WORDS: Readonly<Record<ConversationTab, { label: string; empty: string }>> = {
  internal: { label: 'Internal', empty: 'No internal notes on this task yet.' },
  client: { label: 'Client', empty: 'Nothing has been said to the client on this task yet.' },
  all: { label: 'All activity', empty: 'Nothing has been said on this task yet.' },
};

const TABS: readonly ConversationTab[] = ['internal', 'client', 'all'];

/** The comments a tab shows, oldest first whatever order they arrived in. */
function shownOn(
  tab: ConversationTab,
  comments: CommentsProps['comments'],
): CommentsProps['comments'] {
  const on = tab === 'all' ? comments : comments.filter((comment) => comment.audience === tab);
  return on.toSorted((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at));
}

/** The three tabs, and the chosen tab's thread. */
function Conversation(props: {
  readonly comments: CommentsProps['comments'];
  readonly tab: ConversationTab;
  readonly actions: RowActions;
  readonly onTab: (next: ConversationTab) => void;
}): ReactElement {
  const count = (tab: 'internal' | 'client'): number =>
    props.comments.filter((comment) => comment.audience === tab).length;
  return (
    <>
      <TabStrip
        name="conversation"
        label="Who each part of the conversation is with"
        selected={props.tab}
        onSelect={(next) => {
          props.onTab(TABS.find((tab) => tab === next) ?? 'internal');
        }}
        tabs={TABS.map((tab) => ({
          id: tab,
          label: TAB_WORDS[tab].label,
          badge:
            tab === 'all' ? null : (
              <CountBadge count={count(tab)} title={`${count(tab)} on this task`} />
            ),
        }))}
      />
      {TABS.map((tab) => (
        <TabPanel name="conversation" tab={tab} selected={props.tab} key={tab}>
          {/* Only the chosen tab draws its thread: a comment on both Internal
              and All would otherwise be in the page twice. */}
          {tab === props.tab ? (
            <CommentThread
              comments={shownOn(tab, props.comments)}
              empty={TAB_WORDS[tab].empty}
              actions={props.actions}
            />
          ) : null}
        </TabPanel>
      ))}
    </>
  );
}

/** What a comment says. Enter sends it; Shift and Enter starts a new line. */
function CommentBody(props: {
  readonly body: string;
  readonly locked: boolean;
  readonly onPut: (next: Partial<CommentDraft>) => void;
  readonly onSend: () => void;
}): ReactElement {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    props.onSend();
  };
  return (
    <div className="field">
      <label className="tf__k" htmlFor="comment-body">
        Say something
      </label>
      <textarea
        id="comment-body"
        className="input"
        rows={3}
        required
        disabled={props.locked}
        value={props.body}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          props.onPut({ body: event.target.value });
        }}
      />
    </div>
  );
}

/** The start of a message, enough to say which one a reply answers. */
function excerpt(body: string): string {
  const line = body.replaceAll(/\s+/gu, ' ').trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

/**
 * Editing and deleting a row: each goes out through its own command against
 * the task, and the task is read again whatever the answer, so what is drawn
 * is what the server has. A lost answer is not retried as the same attempt:
 * sending the same words again, or deleting what is already gone, changes
 * nothing, and the reread shows which happened.
 */
function useRowActions(
  props: CommentsProps,
  onReply: (commentId: string) => void,
): { readonly actions: RowActions; readonly because: string | null } {
  const command = useCommand();
  const send = (name: 'task.edit_comment' | 'task.delete_comment', operands: object): void => {
    command.run(
      () =>
        props.client.mutate(
          name,
          { recordId: props.recordId, ...operands },
          { expectedRevision: props.revision },
        ),
      (settlement) => {
        if (
          settlement.kind === 'ok' ||
          settlement.kind === 'unknown' ||
          settlement.kind === 'stale'
        ) {
          props.onPosted();
        }
      },
    );
  };
  return {
    because: command.because,
    actions: {
      busy: command.busy,
      onReply,
      onEdit: (commentId, body) => {
        send('task.edit_comment', { commentId, body });
      },
      onDelete: (commentId) => {
        send('task.delete_comment', { commentId });
      },
    },
  };
}

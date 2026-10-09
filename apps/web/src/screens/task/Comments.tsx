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
// which the stale path below handles. While the outcome is unknown the words,
// recipients, audience and reply stay locked; Post retries that exact attempt.
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
// goes to that message's audience. A reply belongs to the tab it was typed on:
// moving to the other audience's tab drops it, and a message of the other
// audience is never a parent there, so words typed under Internal never reach
// the client by way of a reply. All has no audience of its own, so a reply
// typed there goes where its message is. The thread itself, the pencil and
// the ×, and the signals are drawn by `Thread.tsx`; an edit or a delete goes
// out through its own command and the task is read again, as a post is.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { CountBadge, TabPanel, TabStrip } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalCommentView } from '../../../../../packages/core-wire/src/index.ts';
import { useCommentCustody } from './comment-custody-context.tsx';
import type { CommentHold, PendingComment } from './comment-custody.ts';
import { PanelDoorButton, type ConversationTab, type PanelOpener } from './Perspectives.tsx';
import { CommentThread, type RowActions, type RowEdit } from './Thread.tsx';
import { useRowActions } from './row-actions.ts';
import {
  InternalTaskMentions,
  useInternalTaskMentions,
  unavailableMentions,
  sameMentionsOwner,
  type InternalTaskMentionsOwner,
} from './internal-task-mentions.tsx';

export interface CommentsProps {
  /** Optional authority identity for hosts that reuse a client across grants. */
  readonly grantKey?: string;
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
  /** The dock task panel's opener, for the reply door, which hands it the tab showing (MP-4-8). */
  readonly onOpenPanel?: PanelOpener | undefined;
  /**
   * Where this copy is drawn, carried by its ids: the dock task panel's is
   * `panel`, beside the page's in the same document. Absent on the page.
   */
  readonly scope?: string;
  /** The unsent comment, held above the read so a reread keeps it. Null is an empty box. */
  readonly draft: CommentDraft | null;
  readonly onDraft: (next: CommentDraft | null) => void;
  /** The edit open on one of the reader's rows, held above the read the same way. */
  readonly editing: RowEdit | null;
  readonly onEditing: (next: RowEdit | null) => void;
}

/** An unsent comment: the words, the attempt whose outcome is unknown, and a stale refusal. */
export interface CommentDraft {
  readonly mentions?: readonly string[];
  /** Bound when edited here, so a new owner cannot inherit a held draft. */
  readonly owner?: InternalTaskMentionsOwner;
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

export type { ConversationTab } from './Perspectives.tsx';

/** What a post from each writable tab is: who may read it, and what it is. */
const POSTS: Readonly<Record<'internal' | 'client', { audience: string; kind: string }>> = {
  internal: { audience: 'internal', kind: 'note' },
  client: { audience: 'client', kind: 'client' },
};

/** A comment whose outcome is not known, held so the retry is the same attempt. */
export type { PendingComment } from './comment-custody.ts';

export function Comments(props: CommentsProps): ReactElement {
  const nextOwner: InternalTaskMentionsOwner = {
    client: props.client,
    recordId: props.recordId,
    ...(props.grantKey === undefined ? {} : { grantKey: props.grantKey }),
  };
  const [held, setHeld] = useState<{
    owner: InternalTaskMentionsOwner;
    generation: number;
    discarded: CommentDraft | null;
  }>(() => ({ owner: nextOwner, generation: 0, discarded: null }));
  if (!sameMentionsOwner(held.owner, nextOwner)) {
    setHeld({ owner: nextOwner, generation: held.generation + 1, discarded: props.draft });
  }
  const draft = props.draft;
  const own =
    draft !== held.discarded &&
    (draft?.owner === undefined || sameMentionsOwner(draft.owner, nextOwner));
  return (
    <OwnedComments
      {...props}
      key={held.generation}
      draft={own ? draft : null}
      onDraft={(next) => props.onDraft(next === null ? null : { ...next, owner: nextOwner })}
    />
  );
}

function OwnedComments(props: CommentsProps): ReactElement {
  const scoped = (id: string): string => (props.scope === undefined ? id : `${props.scope}-${id}`);
  const { custody, hold } = useCommentCustody(props.client, props.grantKey, props.recordId);
  const held = hold.pending;
  const hostDraft = props.draft ?? EMPTY;
  const draft = useCommentDraft(props, held);
  const { body, tab, pending } = draft.current;
  const { audience, kind, parentId } = draft.intent;
  // `closed` is set when the server has said this reader may not comment. It
  // disables the control rather than merely reporting, so the same refusal is
  // not fetched again on the next press. Only an authority refusal closes the
  // form: a body the server did not like is something the person can fix and
  // try again. A refusal held above the read closes it the same way.
  const busy = hold.busy;
  const closed = (hold.failure?.kind === 'closed' && !hold.uncertain) || props.refusal !== null;
  // On All nobody has said who may read a post, so there is nothing to post,
  // unless it is a reply, which goes where its message is.
  const picking = pending === null && tab === 'all' && parentId === null;
  const locked = busy || closed || picking;
  const cleanup = !hold.kept && pending === null;
  const cannotPost = busy || (!cleanup && (locked || draft.needsPeople));
  const rows = useRowActions(props, (commentId) => {
    draft.put({ replyTo: commentId });
  });
  const because = hold.failure?.because ?? props.refusal;
  const form = useRef<HTMLFormElement>(null);
  useCommentSettlement(props, hostDraft, hold);

  const post = (): void => {
    if (cannotPost) return;
    if (!hold.kept && pending === null) {
      custody.cleanup(props.recordId);
      return;
    }
    if (form.current?.reportValidity() === false) return;
    const attempt = pending ?? {
      operationId: props.client.newOperationId(),
      revision: props.revision,
      body,
      audience,
      kind,
      parentId,
      ...(draft.mentions.length === 0 ? {} : { mentions: [...draft.mentions] }),
    };
    if (held === null && hostDraft.pending === null)
      props.onDraft({ ...draft.current, stale: null, pending: attempt });
    void custody.post(props.recordId, attempt, held === null && hostDraft.pending !== null);
  };

  return (
    <section className="sb__sect" data-comments="section">
      <CommentsHead count={props.comments.length} />

      <Conversation
        name={scoped('conversation')}
        comments={props.comments}
        tab={tab}
        actions={rows.actions}
        onTab={draft.onTab}
      />
      <RowRefusal because={rows.because} />

      <PostNotices
        because={because}
        stale={draft.current.stale}
        unresolved={
          !busy &&
          pending !== null &&
          (hold.uncertain || (held === null && hostDraft.pending !== null))
        }
      />
      {hold.kept ? null : (
        <p role="status" className="card__sub" data-comment="recovery-storage">
          {pending === null
            ? 'The answer arrived, but the recovery copy could not be cleared. Retry clears that copy before another comment can be sent.'
            : 'The recovery copy could not be updated. The held attempt stays locked.'}
        </p>
      )}

      <form
        id={scoped('task-comment')}
        className="taskform"
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          post();
        }}
      >
        {draft.parent === undefined ? null : (
          <ReplyingTo
            body={draft.parent.body}
            onCancel={() => {
              draft.put({ replyTo: null });
            }}
          />
        )}
        <CommentBody
          id={scoped('comment-body')}
          body={body}
          locked={locked || pending !== null}
          onPut={draft.put}
          onSend={post}
        />
        {audience === 'internal' && !picking ? (
          <InternalTaskMentions
            people={draft.people}
            id={scoped('comment-mentions')}
            selected={draft.mentions}
            locked={locked || pending !== null}
            clearLocked={busy || pending !== null}
            onChange={(ids) => draft.put({ mentions: ids })}
          />
        ) : null}
        {draft.needsPeople ? (
          <p className="card__sub" role="status">
            Selected mentions are unavailable. Wait for the people read or clear mentions before
            posting.
          </p>
        ) : null}
        {picking ? <PickNote /> : null}
        <button
          className="btn btn--primary"
          type="submit"
          data-comment="post"
          disabled={cannotPost}
        >
          {busy
            ? 'Posting…'
            : !hold.kept && pending === null
              ? 'Retry recovery cleanup'
              : 'Post comment'}
        </button>
        {closed ? <ClosedNote /> : null}
      </form>
      <PanelDoorButton door="reply" tab={tab} onOpenPanel={props.onOpenPanel} />
    </section>
  );
}

/** A known answer consumes only this host's submitted draft, including after a reread remount. */
function useCommentSettlement(
  props: CommentsProps,
  hostDraft: CommentDraft,
  hold: CommentHold,
): void {
  const held = hold.pending;
  const because = hold.failure?.because ?? props.refusal;
  const observed = useRef(
    !hold.busy && held === null && matchesSubmittedDraft(hostDraft, hold.settled, props.comments)
      ? hold.settlement - 1
      : hold.settlement,
  );
  useEffect(() => {
    if (observed.current === hold.settlement) return;
    observed.current = hold.settlement;
    if (matchesSubmittedDraft(hostDraft, hold.settled, props.comments)) {
      props.onDraft(
        hold.answered === 'ok'
          ? { ...EMPTY, tab: hostDraft.tab }
          : {
              ...hostDraft,
              pending: null,
              stale: hold.answered === 'stale' ? because : null,
            },
      );
    }
    if (hold.answered === 'closed' && because !== null) props.onRefused(because);
    if (hold.answered === 'ok' || hold.answered === 'stale') props.onPosted();
  }, [hold, props, hostDraft, because]);
}

/** Only the host draft matching the answered envelope is settled by that answer. */
function matchesSubmittedDraft(
  draft: CommentDraft,
  attempt: PendingComment | null,
  comments: readonly InternalCommentView[],
): boolean {
  if (attempt === null) return false;
  const { intent } = commentIntent(draft, comments);
  const mentions = intent.audience === 'internal' ? (draft.mentions ?? []) : [];
  return (
    draft.body === attempt.body &&
    intent.audience === attempt.audience &&
    intent.kind === attempt.kind &&
    intent.parentId === attempt.parentId &&
    JSON.stringify(mentions) === JSON.stringify(attempt.mentions ?? []) &&
    draft.pending?.operationId === attempt.operationId
  );
}

/** A reply names a current parent on this task in the draft's chosen audience. */
function commentIntent(current: CommentDraft, comments: readonly InternalCommentView[]) {
  const { tab, pending } = current;
  const parent = comments.find(
    (comment) =>
      comment.id === current.replyTo &&
      (comment.parent ?? null) === null &&
      (tab === 'all' || comment.audience === tab),
  );
  const tabPost = POSTS[(parent?.audience ?? tab) === 'client' ? 'client' : 'internal'];
  return { parent, intent: pending ?? { ...tabPost, parentId: parent?.id ?? null } };
}

/** The editable draft and the exact held attempt share one audience and recipient vocabulary. */
function useCommentDraft(props: CommentsProps, held: PendingComment | null) {
  const hostDraft = props.draft ?? EMPTY;
  const current: CommentDraft =
    held === null
      ? hostDraft
      : {
          ...hostDraft,
          body: held.body,
          tab:
            hostDraft.body === held.body
              ? hostDraft.tab
              : held.audience === 'client'
                ? 'client'
                : 'internal',
          replyTo: held.parentId,
          mentions: held.mentions ?? [],
          pending: held,
        };
  const { pending } = current;
  const { parent, intent } = commentIntent(current, props.comments);
  const put = (next: Partial<CommentDraft>): void => {
    if (pending !== null) return;
    props.onDraft({ ...current, ...next });
  };
  const onTab = (next: ConversationTab): void => {
    const keeps = parent === undefined || next === 'all' || parent.audience === next;
    put(keeps ? { tab: next } : { tab: next, replyTo: null });
  };
  const mentions = intent.audience === 'internal' ? (current.mentions ?? []) : [];
  const people = useInternalTaskMentions({
    client: props.client,
    recordId: props.recordId,
    ...(props.grantKey === undefined ? {} : { grantKey: props.grantKey }),
  });
  const needsPeople = pending === null && unavailableMentions(people, mentions);
  return { current, intent, parent, put, onTab, mentions, people, needsPeople };
}

/** On All nobody has said who may read a post. */
function PickNote(): ReactElement {
  return (
    <p className="card__sub" data-comment="pick">
      Pick Internal or Client to post, so it is clear who may read it.
    </p>
  );
}

/** The server refused the reader's comment: the box stays closed. */
function ClosedNote(): ReactElement {
  return (
    <p className="card__sub" data-comment="closed">
      The server refused this. The box is closed rather than asking again on your behalf.
    </p>
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

function CommentsHead(props: { readonly count: number }): ReactElement {
  return (
    <div className="sb__sh">
      <span className="sb__k">Comments</span>
      <span className="sbact__meta">{props.count} on this task</span>
    </div>
  );
}

/** An edit or delete on a message, refused: the server's words. */
function RowRefusal(props: { readonly because: string | null }): ReactElement | null {
  return props.because === null ? null : (
    <p className="field__error" role="alert" data-comment="row-refusal">
      {props.because}
    </p>
  );
}

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
  readonly name: string;
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
        name={props.name}
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
        <TabPanel name={props.name} tab={tab} selected={props.tab} key={tab}>
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
  readonly id: string;
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
      <label className="tf__k" htmlFor={props.id}>
        Say something
      </label>
      <textarea
        id={props.id}
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

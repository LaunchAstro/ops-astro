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
// is the comment it already has. Changing the text, the audience or the kind is
// a different comment and gets a new one.

import { useRef, useState, type ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskComment } from '../../operations/shapes.ts';
import { useCommand } from '../../records/use-command.ts';

export interface CommentsProps {
  readonly client: OperationsClient;
  /**
   * An internal reader's comments, every field present. The shared projection
   * is drawn by `SharedTaskDetail.tsx`, which never mounts this box.
   */
  readonly comments: readonly InternalTaskComment[];
  readonly recordId: string;
  /** The revision the comment is written against. `task.comment` does not move it. */
  readonly revision: number;
  /** An earlier refusal on this reader's authority, which outlives the reread. */
  readonly refusal: string | null;
  readonly onRefused: (because: string) => void;
  readonly onPosted: () => void;
}

/** The two audiences the model has. Who may read it, which is not what it is. */
const AUDIENCES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'internal', label: 'Internal — the business only' },
  { value: 'client', label: 'Client — the client may read it' },
];

/**
 * The kinds this screen offers a person.
 *
 * The API accepts a third, `system`. It is not offered here: a system comment
 * is one the product writes about itself, and a box letting a person post one
 * by hand would make every system note on a task unreliable evidence of
 * anything. The gap is recorded in `docs/local/WEB.md` rather than closed.
 */
const KINDS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'client', label: 'Client message' },
];

/** A comment whose outcome is not known, held so the retry is the same attempt. */
interface PendingComment {
  readonly operationId: string;
  readonly body: string;
  readonly audience: string;
  readonly kind: string;
}

export function Comments(props: CommentsProps): ReactElement {
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('internal');
  const [kind, setKind] = useState('note');
  const [pending, setPending] = useState<PendingComment | null>(null);
  const same = (attempt: PendingComment | null): attempt is PendingComment =>
    attempt !== null &&
    attempt.body === body &&
    attempt.audience === audience &&
    attempt.kind === kind;
  // `closed` is set when the server has said this reader may not comment. It
  // disables the control rather than merely reporting, so the same refusal is
  // not fetched again on the next press. Only an authority refusal closes the
  // form: a body the server did not like is something the person can fix and
  // try again. A refusal held above the read closes it the same way.
  const command = useCommand();
  const busy = command.busy;
  const closed = command.closed || props.refusal !== null;
  const locked = busy || closed;
  const because = command.because ?? props.refusal;
  const run = command.run;
  const form = useRef<HTMLFormElement>(null);

  const post = (): void => {
    if (locked) return;
    if (form.current?.reportValidity() === false) return;
    const attempt = same(pending)
      ? pending
      : { operationId: props.client.newOperationId(), body, audience, kind };
    setPending(attempt);
    run(
      () =>
        props.client.mutate(
          'task.comment',
          { recordId: props.recordId, body, audience, commentType: kind },
          { expectedRevision: props.revision, operationId: attempt.operationId },
        ),
      (settlement) => {
        // An unknown outcome keeps the attempt; any answer from the server ends it.
        if (settlement.kind === 'unknown') return;
        setPending(null);
        if (settlement.kind === 'closed') props.onRefused(settlement.because);
        if (settlement.kind !== 'ok') return;
        // Emptied because it has been stored, and the list is reread rather
        // than appended to: what is on the screen is what the server has.
        setBody('');
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

      {props.comments.length === 0 ? (
        <PaneEmpty say="Nothing has been said about this one yet." />
      ) : (
        <div className="thread" data-comments="list">
          {props.comments.map((comment) => (
            <article
              className={`msg msg--${comment.audience}`}
              data-comment-id={comment.id}
              data-audience={comment.audience}
              key={comment.id}
            >
              <div className="sbact__meta">
                {/* The audience is drawn on every comment, because "who may
                    read this" is the one thing a person writing the next one
                    needs to know and the one thing a colour cannot say. */}
                <span className="sb__state" data-comment-audience={comment.audience}>
                  {audienceWord(comment.audience)}
                </span>
                <span> · {comment.comment_type}</span>
                <span> · {comment.author}</span>
                <span> · {comment.posted_at}</span>
              </div>
              <p className="card__body">{comment.body}</p>
            </article>
          ))}
        </div>
      )}

      {because === null ? null : (
        <p className="field__error" role="alert" data-comment="refusal">
          {because}
        </p>
      )}
      {because === null || !same(pending) ? null : (
        <p className="card__sub" data-comment="unresolved">
          This comment may already have been stored. Posting again sends the same attempt, so the
          server answers with the original result rather than storing it twice.
        </p>
      )}

      <form
        id="task-comment"
        className="taskform"
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          post();
        }}
      >
        <div className="field">
          <label className="tf__k" htmlFor="comment-body">
            Say something
          </label>
          <textarea
            id="comment-body"
            className="input"
            rows={3}
            required
            disabled={locked}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="comment-audience">
            Who may read it
          </label>
          <select
            id="comment-audience"
            className="input"
            disabled={locked}
            value={audience}
            onChange={(event) => {
              setAudience(event.target.value);
            }}
          >
            {AUDIENCES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="comment-kind">
            What it is
          </label>
          <select
            id="comment-kind"
            className="input"
            disabled={locked}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
            }}
          >
            {KINDS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn--primary" type="submit" data-comment="post" disabled={locked}>
          {busy ? 'Posting…' : 'Post comment'}
        </button>
        {!closed ? null : (
          <p className="card__sub" data-comment="closed">
            The server refused this. The box is closed rather than asking again on your behalf.
          </p>
        )}
      </form>
    </section>
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

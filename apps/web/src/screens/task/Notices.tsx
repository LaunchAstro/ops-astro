// SPDX-License-Identifier: AGPL-3.0-only
//
// The notices above the task page's controls. `TaskDetail.tsx` holds the
// state each one draws and says why a stale press and a stale draft are told
// apart; the heading is `Header.tsx`.

import type { ReactElement } from 'react';
import type { WireRefusal } from '../../operations/client.ts';
import { describeRefusal } from '../../records/submit.ts';

/** A stale lifecycle or assignee press, quoted across the reread it caused. */
export function MovedNotice(props: { readonly because: string | null }): ReactElement | null {
  return props.because === null ? null : (
    <section className="sb__sect" role="alert" data-conflict="moved">
      <p className="field__error">{props.because}</p>
      <p className="card__sub">
        Somebody else moved this task on first, so nothing you pressed was stored. It has been read
        again: press it again if it still applies.
      </p>
    </section>
  );
}

/** Somebody else moved the record on while this draft was being made. */
export function ConflictNotice(props: {
  readonly conflict: WireRefusal | null;
  /** The revision the edit was made against. */
  readonly base: number;
  readonly title: string;
  readonly due: string;
  readonly onDiscard: () => void;
}): ReactElement | null {
  return props.conflict === null ? null : (
    <section className="sb__sect" role="alert" data-conflict="version">
      <div className="sb__sh">
        <span className="sb__k">Somebody else changed this task</span>
      </div>
      <p className="field__error">{describeRefusal(props.conflict)}</p>
      <p className="card__sub">
        Your edit was made against revision {props.base}. Copy anything you want to keep, then read
        the task again and make the change on top of theirs.
      </p>
      <ul className="card__sub" data-conflict="unsaved">
        <li>Title: {props.title}</li>
        <li>Due date: {props.due === '' ? 'none' : props.due}</li>
      </ul>
      <button className="btn" type="button" data-conflict="reload" onClick={props.onDiscard}>
        Read it again and start from theirs
      </button>
    </section>
  );
}

/** The choice an unsaved draft asks for before anything else on the page runs. */
export function UnsavedBar(props: {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onDiscard: () => void;
}): ReactElement | null {
  return !props.dirty ? null : (
    <section className="sb__sect" data-draft-resolve="choice">
      <div className="sb__sh">
        <span className="sb__k">Unsaved changes</span>
      </div>
      <p className="card__sub">
        The title or due date has been edited and not saved. Assigning, changing the state and
        refreshing are unavailable until this is settled — nothing here is merged for you.
      </p>
      <div className="btnrow">
        <button
          className="btn btn--primary"
          type="submit"
          form="task-fields"
          data-draft-resolve="save"
          disabled={props.busy}
        >
          Save changes
        </button>
        <button
          className="btn"
          type="button"
          data-draft-resolve="discard"
          disabled={props.busy}
          onClick={props.onDiscard}
        >
          Discard changes
        </button>
      </div>
    </section>
  );
}

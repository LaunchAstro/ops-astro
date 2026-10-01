// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's heading and the notices above its controls. `TaskDetail.tsx`
// holds the state each one draws and says why a stale press and a stale draft
// are told apart.

import type { ReactElement } from 'react';
import { Spill } from '@launchastro/ui';
import type { InternalTaskDetail } from '../../../../../packages/core-wire/src/index.ts';
import type { WireRefusal } from '../../operations/client.ts';
import { describeRefusal } from '../../records/submit.ts';
import { pathTo } from '../../routes.ts';
import { drawTaskState } from '../../views/task-state.ts';
import { titleOf } from '../../views/task-title.ts';
import { TaskFacts } from './Facts.tsx';

/** The crumb, the title (or the placeholder for a task with none) and the revision. */
export function TaskHeader(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  return (
    <>
      <header className="tpr">
        <div className="tpr__crumb">
          <a className="sb__addr" href={pathTo('agency:projects-board')}>
            Projects
          </a>
          <span aria-hidden="true">›</span>
          <span>No board</span>
          <span className="sbact__meta">· {task.key}</span>
          <Spill state={drawTaskState(task.state)} />
        </div>
        <h2 className="tpr__title">{titleOf(task.title)}</h2>
        <div className="card__sub">
          Revision {task.revision} ·{' '}
          {task.completedAt === null ? 'not completed' : `completed ${task.completedAt}`}
        </div>
      </header>
      <TaskFacts task={task} />
    </>
  );
}

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

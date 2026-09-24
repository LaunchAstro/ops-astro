// SPDX-License-Identifier: AGPL-3.0-only
//
// `/task/:key`. One task, everything the slice can do to it, and the revision
// it is all happening against.
//
// **The revision is on the screen.** Every write carries the revision the edit
// was made against, and a person who can see it can tell a stale screen from a
// current one without reloading. It is also what makes `VERSION_STALE`
// legible when it arrives (N5).
//
// **Each field goes out through the operation that owns it.** Title and due
// date through `task.update`, the assignee through `task.assign`, the state
// through `task.start`/`task.complete`/`task.reopen`. That mapping is the
// server's, from the field definitions; this screen honours it rather than
// enforcing it — the generic submission module sends what it is given, so a
// protected field posted to the wrong operation is refused by the server and
// the refusal is what a person reads (N3).
//
// **An unsaved edit is resolved, never merged.** Two rounds of draft work tried
// to keep typing alive across a refresh and each round found another way for it
// to be lost or to overwrite somebody else. So this screen stops merging. While
// the title or due date is unsaved the screen has one question on it — Save or
// Discard — and assignment, the lifecycle buttons and Refresh are disabled
// until it is answered. Nothing reads a draft across a refresh because no
// refresh can start while one exists.
//
// **A draft remembers where it started.** It records the revision and the field
// values it began from, and its save sends *that* revision as
// `expectedRevision`. A concurrent writer who moved the record on gets the
// server's `VERSION_STALE` and the person is shown a conflict to resolve,
// rather than their form quietly carrying a revision it was never checked
// against and erasing the other writer's field.
//
// **Nothing is editable while its own request is in flight.** The inputs are
// disabled for the length of a save, and a settlement clears only the exact
// draft generation it submitted, so a slow response cannot delete newer typing.
//
// **Comments are the server's list, and the screen never adds to it**
// (`task/Comments.tsx`). A screen that appended the comment it had just sent
// would be drawing a row that may never have been stored, which is B7's
// failure in a friendlier costume.
//
// **The proposals are one answer, and the decision carries the version out of
// it.** `task.read` brings the proposal projection with the task, so the
// `versionId` the approve control sends is the version whose evidence and digest
// are on the screen beside it. A refused decision is quoted and then the task is
// read again, and the refusal text is held here rather than inside the proposals
// view because the reread unmounts everything under the read state.
//
// **A refused comment is asked once** (`task/Comments.tsx`), so a member
// without the grant is not invited to be refused over and over. The refusal is
// held here, as the decision note is, so an unrelated write's reread does not
// open the box again. The propose form's refusal is held the same way.
//
// **Only a stale save of the draft is drawn as a draft conflict.** A stale
// lifecycle or assignee press had nothing unsaved in it, so it is quoted as the
// server's `VERSION_STALE` and the task is read again, and the quote is held
// here because that reread unmounts the page below the read.
//
// **A reader outside the business gets the shared view, not this page with
// holes in it.** Its `task.read` answers `sharedTask` instead of `task`, and
// that key alone picks `SharedTaskDetail`: the screen never guesses from a
// role, never builds a task out of the projection, and never reads anything
// else to fill it. Refresh and the denied state are shared by both, so a
// revoked share empties the page the same way a revoked grant does.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Spill } from '@launchastro/ui';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import type { PersonListResult, TaskDetail as Task, TaskReadResult } from '../operations/shapes.ts';
import { useRead } from '../data/use-read.ts';
import { Proposals, type DecisionNote } from '../views/proposals.tsx';
import { RecordState } from '../views/record-state.tsx';
import { drawTaskState } from '../views/task-state.ts';
import { describeRefusal, submitEdit } from '../records/submit.ts';
import { useCommand } from '../records/use-command.ts';
import { pathTo } from '../routes.ts';
import { SharedTaskDetail } from './SharedTaskDetail.tsx';
import { Comments } from './task/Comments.tsx';
import { DetailsForm } from './task/DetailsForm.tsx';
import { History } from './task/History.tsx';
import { Assignee, Lifecycle, type LifecycleCommand } from './task/Lifecycle.tsx';

export interface TaskDetailProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskKey: string;
}

/** Where an unsaved edit began: the revision, and the values as they stood. */
interface DraftBase {
  readonly revision: number;
  readonly title: string;
  readonly due: string;
}

/** An unsaved title and due date, and everything needed to settle it safely. */
interface Draft {
  /** Grant and task together: a draft belongs to one task under one grant. */
  readonly identity: string;
  /**
   * Bumped by every keystroke. A save settles the generation it submitted and
   * no other, so a response that arrives after further typing clears nothing.
   */
  readonly generation: number;
  readonly base: DraftBase;
  readonly title: string;
  readonly due: string;
}

export function TaskDetailScreen(props: TaskDetailProps): ReactElement {
  const client = props.client;
  const { state, reload } = useRead<TaskReadResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskReadResult>('task.read', { recordId: props.taskKey }),
    deps: [props.taskKey],
  });

  // **The draft lives above the read.** `RecordState` unmounts `Loaded` while a
  // read is in flight, and the draft has to outlive that to be settled at all.
  // It is still dropped exactly where it always was: a different task, a
  // different grant, or a read the server denied. A draft that outlived its
  // authority would be stale authorised data left on the screen, which is the
  // thing that must not happen.
  const identity = `${props.grantKey}\u0000${props.taskKey}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  if (draft !== null && (draft.identity !== identity || state.outcome === 'denied')) {
    setDraft(null);
  }
  const held = draft !== null && draft.identity === identity ? draft : null;

  // **A refused decision is remembered above the read, for one task under one
  // grant.** Deciding rereads the task, and a reread unmounts everything below
  // `RecordState`, so a refusal held inside the proposals view would disappear
  // together with the version it was about — the screen would change and say
  // nothing about why. It is dropped when the task or the reader changes, for
  // the same reason a draft is: it is an answer about one record read under one
  // authority. The comment and proposal refusals, and a stale press's quote,
  // are held the same way for the same reason.
  const denied = state.outcome === 'denied';
  const [note, setNote] = useHeld<DecisionNote>(identity, denied);
  const [commentRefusal, setCommentRefusal] = useHeld<string>(identity, denied);
  const [proposeRefusal, setProposeRefusal] = useHeld<string>(identity, denied);
  const [moved, setMoved] = useHeld<string>(identity, denied);

  return (
    <div className="stack">
      {/*
        Refresh sits outside the read's own region on purpose. Inside it, the
        loading rendering replaces the controls, so a person waiting on a slow
        read has nothing to press and the screen can never have two reads in
        flight. Out here it stays pressable while a read is running, which is
        what makes the ordering rule observable in the product rather than only
        in a unit test: press it twice and the answers may come back in either
        order, and the older one must not win.

        It is disabled while an edit is unsaved. A refresh is the moment a draft
        and the server's values would have to be reconciled, and this screen
        does not reconcile them — the person does, with the Save or Discard
        choice the form is showing them.
      */}
      <div className="btnrow">
        <button
          className="btn"
          type="button"
          data-refresh="task"
          disabled={held !== null}
          onClick={reload}
        >
          Refresh
        </button>
        {held === null ? null : (
          <span className="sbact__meta" data-draft-resolve="why">
            Save or discard your unsaved changes before refreshing.
          </span>
        )}
      </div>
      <RecordState state={state} subject="task" onRetry={reload}>
        {(value) =>
          'sharedTask' in value ? (
            <SharedTaskDetail task={value.sharedTask} />
          ) : (
            <Loaded
              client={client}
              grantKey={props.grantKey}
              task={value.task}
              draft={held}
              note={note}
              onDecided={setNote}
              commentRefusal={commentRefusal}
              onCommentRefused={setCommentRefusal}
              proposeRefusal={proposeRefusal}
              onProposeRefused={setProposeRefusal}
              moved={moved}
              onMoved={setMoved}
              onDraft={(next, base) => {
                if (next === null) {
                  setDraft(null);
                  return;
                }
                setDraft((current) =>
                  current !== null && current.identity === identity
                    ? {
                        ...current,
                        title: next.title,
                        due: next.due,
                        generation: current.generation + 1,
                      }
                    : { identity, generation: 1, base, title: next.title, due: next.due },
                );
              }}
              onSaved={(generation) => {
                // Only the generation that was submitted. A save that settles
                // after further typing has answered a question nobody is asking
                // any more, and clearing the newer draft here is exactly how the
                // person's newer text used to disappear.
                setDraft((current) =>
                  current !== null &&
                  current.identity === identity &&
                  current.generation === generation
                    ? null
                    : current,
                );
              }}
              onDiscard={() => {
                setDraft(null);
                reload();
              }}
              onChanged={reload}
            />
          )
        }
      </RecordState>
    </div>
  );
}

/**
 * One answer held above the read, for one task under one grant.
 *
 * Dropped when the task or the grant changes or the read is denied, the same
 * rules the draft follows: it is an answer about one record read under one
 * authority, and it must not outlive either.
 */
function useHeld<T>(
  identity: string,
  denied: boolean,
): readonly [T | null, (next: T | null) => void] {
  const [held, setHeld] = useState<{ readonly identity: string; readonly value: T } | null>(null);
  if (held !== null && (held.identity !== identity || denied)) {
    setHeld(null);
  }
  const value = held !== null && held.identity === identity ? held.value : null;
  const set = (next: T | null): void => {
    setHeld(next === null ? null : { identity, value: next });
  };
  return [value, set];
}

interface LoadedProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  /** The unsaved edit, or nothing. Its presence is what "dirty" means. */
  readonly draft: Draft | null;
  /** What the server said about the last decision, or nothing. */
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  /** This reader's refused comment, held above the read so a reread keeps it. */
  readonly commentRefusal: string | null;
  readonly onCommentRefused: (because: string) => void;
  /** This reader's refused proposal, held the same way. */
  readonly proposeRefusal: string | null;
  readonly onProposeRefused: (because: string) => void;
  /** The last stale lifecycle or assignee press, quoted across its reread. */
  readonly moved: string | null;
  readonly onMoved: (because: string | null) => void;
  readonly onDraft: (next: { title: string; due: string } | null, base: DraftBase) => void;
  readonly onSaved: (generation: number) => void;
  readonly onDiscard: () => void;
  readonly onChanged: () => void;
}

function Loaded(props: LoadedProps): ReactElement {
  const { client, task } = props;
  // `conflict`: somebody else moved the record on while this edit was being
  // made. The draft stays on the screen (it is the person's work) and the
  // screen asks them to resolve it rather than resending against a revision
  // they never saw. Every other failure is quoted as it arrived.
  //
  // The controls stay on `busy`, not `locked`: this one command state serves
  // several commands (lifecycle, assignment, the details form), and one
  // command's authority refusal must not close the others.
  //
  // `fromFields` records which of them sent the last write, because only a
  // stale save of the draft is a draft conflict. A stale lifecycle or assignee
  // press is quoted above the read (`moved`) and the task is read again.
  const { busy, because: failed, failure, conflict: stale, run: send } = useCommand();
  const [fromFields, setFromFields] = useState(false);
  const conflict = fromFields ? stale : null;
  const because = failure?.kind === 'stale' ? null : failed;
  // The details form itself, so the resolve bar's Save can ask it whether the
  // edit it is about to send is a legal one.
  const fields = useRef<HTMLFormElement>(null);
  const saved = { title: task.title, due: task.due === null ? '' : task.due.slice(0, 10) };
  const [title, setTitle] = useState(props.draft?.title ?? saved.title);
  const [due, setDue] = useState(props.draft?.due ?? saved.due);

  // Where this edit began. An existing draft keeps its own starting point; a
  // first keystroke takes the record as it stands right now.
  const base: DraftBase = props.draft?.base ?? {
    revision: task.revision,
    title: saved.title,
    due: saved.due,
  };
  const dirty = props.draft !== null;

  /** Every keystroke lands in both places: this form, and the draft above it. */
  const edit = (next: { title?: string; due?: string }): void => {
    const nextTitle = next.title ?? title;
    const nextDue = next.due ?? due;
    setTitle(nextTitle);
    setDue(nextDue);
    // Typed back to where it started is not an unsaved edit. Holding a draft
    // there would lock the other controls for no reason a person could see.
    props.onDraft(
      nextTitle === base.title && nextDue === base.due ? null : { title: nextTitle, due: nextDue },
      base,
    );
  };

  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    isEmpty: (value) => value.persons.length === 0,
    deps: [],
  });

  /** One place every write lands, so every refusal is shown the same way. */
  const run = (
    work: () => Promise<CallResult<unknown>>,
    settles: number | null = null,
    draftSave = false,
  ): void => {
    if (busy) return;
    setFromFields(draftSave);
    props.onMoved(null);
    send(work, (settlement) => {
      if (settlement.kind === 'stale' && !draftSave) {
        // Nothing unsaved was in this press, so there is nothing to resolve:
        // the server's words are kept across the reread that follows.
        props.onMoved(settlement.because);
        props.onChanged();
        return;
      }
      if (settlement.kind !== 'ok') return;
      if (settles !== null) props.onSaved(settles);
      props.onChanged();
    });
  };

  const lifecycle = (command: LifecycleCommand): void => {
    const body = command === 'task.reopen' ? { reason: 'Reopened from the task page.' } : {};
    run(() =>
      client.mutate(command, { recordId: task.id, ...body }, { expectedRevision: task.revision }),
    );
  };

  const saveFields = (): void => {
    // Both ordinary fields in one edit, through the generic submission module.
    // `due` is sent as null when it has been cleared: an absent field is "do
    // not change" and an explicit null is "there is no due date", and the two
    // are different instructions.
    //
    // The revision is the draft's, not the screen's. That is the whole of the
    // stale-edit protection: an edit begun at revision N is offered at N, and
    // if the record has moved the server says so.
    run(
      () =>
        submitEdit(client, {
          command: 'task.update',
          recordId: task.id,
          expectedRevision: base.revision,
          fields: { title, due: due === '' ? null : due },
        }),
      props.draft?.generation ?? null,
      true,
    );
  };

  /**
   * The one way a detail edit leaves this screen. Both Save controls arrive
   * here: the form's own submit button, and the resolve bar's, which is
   * associated with the form by `form="task-fields"` even though it is drawn
   * outside it. A control that called `saveFields` directly would be a second
   * path with none of the form's checks on it, and Title is `required` — the
   * previous direct call sent `title: ''` for a cleared title, which the core's
   * text check accepts and the board then draws as a task with a blank link.
   *
   * `reportValidity` is the reporting half, not a duplicate of the browser's
   * own: it says which field is wrong instead of failing silently, and it makes
   * the single path hold in any environment rather than only where interactive
   * validation runs.
   */
  const submitFields = (): void => {
    if (fields.current?.reportValidity() === false) return;
    saveFields();
  };

  const onFields = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submitFields();
  };

  const onAssign = (personId: string): void => {
    run(() =>
      submitEdit(client, {
        command: 'task.assign',
        recordId: task.id,
        expectedRevision: task.revision,
        fields: { assignee: personId === '' ? null : personId },
      }),
    );
  };

  return (
    <div className="stack" data-task={task.id} data-revision={task.revision}>
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
        <h2 className="tpr__title">{task.title}</h2>
        <div className="card__sub">
          Revision {task.revision} ·{' '}
          {task.completedAt === null ? 'not completed' : `completed ${task.completedAt}`}
        </div>
      </header>

      {because === null ? null : (
        <p className="field__error" role="alert" data-voice="input-wrong">
          {because}
        </p>
      )}

      {props.moved === null ? null : (
        <section className="sb__sect" role="alert" data-conflict="moved">
          <p className="field__error">{props.moved}</p>
          <p className="card__sub">
            Somebody else moved this task on first, so nothing you pressed was stored. It has been
            read again: press it again if it still applies.
          </p>
        </section>
      )}

      {conflict === null ? null : (
        <section className="sb__sect" role="alert" data-conflict="version">
          <div className="sb__sh">
            <span className="sb__k">Somebody else changed this task</span>
          </div>
          <p className="field__error">{describeRefusal(conflict)}</p>
          <p className="card__sub">
            Your edit was made against revision {base.revision}. Copy anything you want to keep,
            then read the task again and make the change on top of theirs.
          </p>
          <ul className="card__sub" data-conflict="unsaved">
            <li>Title: {title}</li>
            <li>Due date: {due === '' ? 'none' : due}</li>
          </ul>
          <button className="btn" type="button" data-conflict="reload" onClick={props.onDiscard}>
            Read it again and start from theirs
          </button>
        </section>
      )}

      {!dirty ? null : (
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
              disabled={busy}
            >
              Save changes
            </button>
            <button
              className="btn"
              type="button"
              data-draft-resolve="discard"
              disabled={busy}
              onClick={props.onDiscard}
            >
              Discard changes
            </button>
          </div>
        </section>
      )}

      <Lifecycle disabled={busy || dirty} onLifecycle={lifecycle} />

      <Assignee
        people={people.state}
        onRetry={people.reload}
        assignee={task.assignee}
        disabled={busy || dirty}
        onAssign={onAssign}
      />

      <DetailsForm
        formRef={fields}
        busy={busy}
        title={title}
        due={due}
        onEdit={edit}
        onSubmit={onFields}
      />

      <Comments
        client={client}
        comments={task.comments}
        recordId={task.id}
        revision={task.revision}
        refusal={props.commentRefusal}
        onRefused={props.onCommentRefused}
        onPosted={props.onChanged}
      />

      <Proposals
        client={client}
        note={props.note}
        onChanged={props.onChanged}
        onDecided={props.onDecided}
        onProposeRefused={props.onProposeRefused}
        proposeRefusal={props.proposeRefusal}
        proposals={task.proposals}
        recordId={task.id}
        revision={task.revision}
      />

      <History history={task.history} />
    </div>
  );
}

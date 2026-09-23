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
// **Comments are the server's list, and the screen never adds to it.** A post
// goes out through `task.comment` and the list is reread from `task.read`; a
// screen that appended the comment it had just sent would be drawing a row that
// may never have been stored, which is B7's failure in a friendlier costume.
// The write leaves the task's own revision alone, so nothing else on the page
// goes stale because somebody said something.
//
// **The proposals are one answer, and the decision carries the version out of
// it.** `task.read` brings the proposal projection with the task, so the
// `versionId` the approve control sends is the version whose evidence and digest
// are on the screen beside it. A refused decision is quoted and then the task is
// read again, and the refusal text is held here rather than inside the proposals
// view because the reread unmounts everything under the read state.
//
// **A refused comment is asked once.** There is no grant read anywhere in this
// build, so this screen cannot know whether a person holds `comment` before it
// asks. What it can do is ask once, quote the server's own code, and then stop
// offering a control that has already been refused for this reader — so a
// member without the grant is not invited to be refused over and over.
//
// **A reader outside the business gets the shared view, not this page with
// holes in it.** Its `task.read` answers `sharedTask` instead of `task`, and
// that key alone picks `SharedTaskDetail`: the screen never guesses from a
// role, never builds a task out of the projection, and never reads anything
// else to fill it. Refresh and the denied state are shared by both, so a
// revoked share empties the page the same way a revoked grant does.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { PaneEmpty, Spill, drawPinnedStepWord, type DrawnState } from '@launchastro/ui';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import type {
  PersonListResult,
  TaskComment,
  TaskDetail as Task,
  TaskReadResult,
} from '../operations/shapes.ts';
import { useRead } from '../data/use-read.ts';
import { Proposals, type DecisionNote } from '../views/proposals.tsx';
import { RecordState } from '../views/record-state.tsx';
import { describeRefusal, submitEdit } from '../records/submit.ts';
import { useCommand } from '../records/use-command.ts';
import { SharedTaskDetail } from './SharedTaskDetail.tsx';

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
  // authority.
  const [decision, setDecision] = useState<{
    readonly identity: string;
    readonly note: DecisionNote;
  } | null>(null);
  if (decision !== null && (decision.identity !== identity || state.outcome === 'denied')) {
    setDecision(null);
  }
  const note = decision !== null && decision.identity === identity ? decision.note : null;

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
              onDecided={(next) => {
                setDecision(next === null ? null : { identity, note: next });
              }}
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

interface LoadedProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  /** The unsaved edit, or nothing. Its presence is what "dirty" means. */
  readonly draft: Draft | null;
  /** What the server said about the last decision, or nothing. */
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  readonly onDraft: (next: { title: string; due: string } | null, base: DraftBase) => void;
  readonly onSaved: (generation: number) => void;
  readonly onDiscard: () => void;
  readonly onChanged: () => void;
}

function Loaded(props: LoadedProps): ReactElement {
  const { client, task } = props;
  const { busy, failure, run: send } = useCommand();
  // Somebody else moved the record on while this edit was being made. The
  // draft stays on the screen (it is the person's work) and the screen asks
  // them to resolve it rather than resending against a revision they never
  // saw. Every other failure is quoted as it arrived.
  const conflict = failure?.kind === 'stale' ? failure.refusal : null;
  const because = failure === null || failure.kind === 'stale' ? null : failure.because;
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
  const run = (work: () => Promise<CallResult<unknown>>, settles: number | null = null): void => {
    send(work, (settlement) => {
      if (settlement.kind !== 'ok') return;
      if (settles !== null) props.onSaved(settles);
      props.onChanged();
    });
  };

  const lifecycle = (command: 'task.start' | 'task.complete' | 'task.reopen'): void => {
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
          <a className="sb__addr" href="/projects/">
            Projects
          </a>
          <span aria-hidden="true">›</span>
          <span>No board</span>
          <span className="sbact__meta">· {task.key}</span>
          <Spill state={stateOf(task)} />
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

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">State</span>
        </div>
        <div className="btnrow">
          <button
            className="btn"
            type="button"
            data-lifecycle="start"
            disabled={busy || dirty}
            onClick={() => {
              lifecycle('task.start');
            }}
          >
            Start
          </button>
          <button
            className="btn"
            type="button"
            data-lifecycle="complete"
            disabled={busy || dirty}
            onClick={() => {
              lifecycle('task.complete');
            }}
          >
            Complete
          </button>
          <button
            className="btn"
            type="button"
            data-lifecycle="reopen"
            disabled={busy || dirty}
            onClick={() => {
              lifecycle('task.reopen');
            }}
          >
            Reopen
          </button>
        </div>
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Assignee</span>
        </div>
        <RecordState state={people.state} subject="people" onRetry={people.reload}>
          {(value) => (
            <select
              className="input"
              aria-label="Assignee"
              disabled={busy || dirty}
              value={task.assignee?.personId ?? ''}
              onChange={(event) => {
                onAssign(event.target.value);
              }}
            >
              <option value="">Unassigned</option>
              {value.persons.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </RecordState>
      </section>

      <form id="task-fields" className="sb__sect taskform" ref={fields} onSubmit={onFields}>
        <div className="sb__sh">
          <span className="sb__k">Details</span>
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="task-title">
            Title
          </label>
          {/*
            Disabled while the save is in flight. An input that stays live
            during its own request invites the person to type something the
            response is about to throw away, and no amount of care on the
            settlement side makes that typing visible to the server.
          */}
          <input
            id="task-title"
            className="input"
            type="text"
            required
            disabled={busy}
            value={title}
            onChange={(event) => {
              edit({ title: event.target.value });
            }}
          />
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="task-due">
            Due date
          </label>
          <input
            id="task-due"
            className="input"
            type="date"
            disabled={busy}
            value={due}
            onChange={(event) => {
              edit({ due: event.target.value });
            }}
          />
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          Save changes
        </button>
      </form>

      <Comments
        client={client}
        comments={task.comments}
        recordId={task.id}
        revision={task.revision}
        onPosted={props.onChanged}
      />

      <Proposals
        client={client}
        note={props.note}
        onChanged={props.onChanged}
        onDecided={props.onDecided}
        proposals={task.proposals}
        recordId={task.id}
        revision={task.revision}
      />

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">History</span>
        </div>
        {task.history.length === 0 ? (
          <PaneEmpty say="Nothing has changed on this one yet." />
        ) : (
          <div className="sbact">
            {task.history.map((entry, index) => (
              <div className="sbact__row" key={`${entry.at}-${String(index)}`}>
                <span className="sbact__meta">
                  {entry.at} · {entry.actorId}
                </span>
                <span className="sb__state">{entry.operation}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface CommentsProps {
  readonly client: OperationsClient;
  readonly comments: readonly TaskComment[];
  readonly recordId: string;
  /** The revision the comment is written against. `task.comment` does not move it. */
  readonly revision: number;
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

function Comments(props: CommentsProps): ReactElement {
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('internal');
  const [kind, setKind] = useState('note');
  const { busy, failure, run } = useCommand();
  const because = failure?.because ?? null;
  // Set when the server has said this reader may not comment. It disables the
  // control rather than merely reporting, so the same refusal is not fetched
  // again on the next press. Only an authority refusal closes the form: a body
  // the server did not like is something the person can fix and try again.
  const refusedOutright = failure?.kind === 'closed';
  const form = useRef<HTMLFormElement>(null);

  const post = (): void => {
    if (busy || refusedOutright) return;
    if (form.current?.reportValidity() === false) return;
    run(
      () =>
        props.client.mutate(
          'task.comment',
          { recordId: props.recordId, body, audience, commentType: kind },
          { expectedRevision: props.revision },
        ),
      (settlement) => {
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
              className={`msg msg--${comment.audience ?? 'unknown'}`}
              data-comment-id={comment.id}
              data-audience={comment.audience ?? 'unknown'}
              key={comment.id}
            >
              <div className="sbact__meta">
                {/* The audience is drawn on every comment, because "who may
                    read this" is the one thing a person writing the next one
                    needs to know and the one thing a colour cannot say. */}
                <span className="sb__state" data-comment-audience={comment.audience ?? 'unknown'}>
                  {audienceWord(comment.audience)}
                </span>
                {comment.comment_type === undefined ? null : <span> · {comment.comment_type}</span>}
                {comment.author === undefined ? null : <span> · {comment.author}</span>}
                {comment.posted_at === undefined ? null : <span> · {comment.posted_at}</span>}
              </div>
              <p className="card__body">{comment.body ?? ''}</p>
            </article>
          ))}
        </div>
      )}

      {because === null ? null : (
        <p className="field__error" role="alert" data-comment="refusal">
          {because}
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
            disabled={busy || refusedOutright}
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
            disabled={busy || refusedOutright}
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
            disabled={busy || refusedOutright}
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
        <button
          className="btn btn--primary"
          type="submit"
          data-comment="post"
          disabled={busy || refusedOutright}
        >
          {busy ? 'Posting…' : 'Post comment'}
        </button>
        {!refusedOutright ? null : (
          <p className="card__sub" data-comment="closed">
            The server refused this. The box is closed rather than asking again on your behalf.
          </p>
        )}
      </form>
    </section>
  );
}

/** The audience in the words a person reads, and the server's own word kept. */
function audienceWord(audience: string | undefined): string {
  if (audience === 'internal') return 'Internal';
  if (audience === 'client') return 'Client';
  // A word this build does not know is printed as it arrived. Inventing a
  // label for it would hide the fact that something new is being stored.
  return audience ?? 'no audience';
}

function stateOf(task: Task): DrawnState {
  // A task with no state is an incomplete record, not a crash and not a
  // blank cell. It says so, in the vocabulary the projection already has for
  // a word it cannot place, and the row stays on the screen.
  if (task.state === null) return { word: 'No state', tone: 'wait', reference: 'unknown' };
  const drawn = drawPinnedStepWord(TONE_BY_CATEGORY[task.state.machineCategory] ?? 'pending');
  return { word: task.state.label, tone: drawn.tone, reference: 'new_behaviour' };
}

const TONE_BY_CATEGORY: Readonly<Record<string, string>> = {
  unstarted: 'pending',
  started: 'running',
  backlog: 'waiting',
  completed: 'done',
  cancelled: 'refused',
};

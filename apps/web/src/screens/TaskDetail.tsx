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

import { useState, type FormEvent, type ReactElement } from 'react';
import { PaneEmpty, Spill, drawPinnedStepWord, type DrawnState } from '@launchastro/ui';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../operations/client.ts';
import type { PersonListResult, TaskDetail as Task, TaskReadResult } from '../operations/shapes.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { describeFailure, submitEdit } from '../records/submit.ts';

export interface TaskDetailProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskKey: string;
}

export function TaskDetailScreen(props: TaskDetailProps): ReactElement {
  const client = props.client;
  const { state, reload } = useRead<TaskReadResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskReadResult>('task.read', { recordId: props.taskKey }),
    deps: [props.taskKey],
  });

  return (
    <RecordState state={state} subject="task" onRetry={reload}>
      {(value) => (
        <Loaded client={client} grantKey={props.grantKey} task={value.task} onChanged={reload} />
      )}
    </RecordState>
  );
}

interface LoadedProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  readonly onChanged: () => void;
}

function Loaded(props: LoadedProps): ReactElement {
  const { client, task } = props;
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(task.due === null ? '' : task.due.slice(0, 10));

  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    isEmpty: (value) => value.persons.length === 0,
    deps: [],
  });

  /** One place every write lands, so every refusal is shown the same way. */
  const after = (result: CallResult<unknown>): void => {
    setBusy(false);
    const failure = isRefusal(result) || isUnavailable(result) ? describeFailure(result) : null;
    setBecause(failure);
    if (failure === null) props.onChanged();
  };

  const run = (work: Promise<CallResult<unknown>>): void => {
    setBusy(true);
    setBecause(null);
    void work.then(after);
  };

  const lifecycle = (command: 'task.start' | 'task.complete' | 'task.reopen'): void => {
    const body = command === 'task.reopen' ? { reason: 'Reopened from the task page.' } : {};
    run(
      client.mutate(command, { recordId: task.id, ...body }, { expectedRevision: task.revision }),
    );
  };

  const onFields = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // Both ordinary fields in one edit, through the generic submission module.
    // `due` is sent as null when it has been cleared: an absent field is "do
    // not change" and an explicit null is "there is no due date", and the two
    // are different instructions.
    run(
      submitEdit(client, {
        command: 'task.update',
        recordId: task.id,
        expectedRevision: task.revision,
        fields: { title, due: due === '' ? null : due },
      }),
    );
  };

  const onAssign = (personId: string): void => {
    run(
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

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">State</span>
        </div>
        <div className="btnrow">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              lifecycle('task.start');
            }}
          >
            Start
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              lifecycle('task.complete');
            }}
          >
            Complete
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
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
              disabled={busy}
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

      <form className="sb__sect taskform" onSubmit={onFields}>
        <div className="sb__sh">
          <span className="sb__k">Details</span>
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="task-title">
            Title
          </label>
          <input
            id="task-title"
            className="input"
            type="text"
            required
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
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
            value={due}
            onChange={(event) => {
              setDue(event.target.value);
            }}
          />
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          Save changes
        </button>
      </form>

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

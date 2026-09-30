// SPDX-License-Identifier: AGPL-3.0-only
//
// `/projects/`. The board of the business's unboarded tasks, and the form that
// makes one.
//
// The read is `task.board` with `board: null`, which the contract defines as
// the business's unboarded tasks — the acceptance case creates a task
// **without a board** and expects to find it (B1).
//
// The board is the board machine with the Projects board's nine columns
// (MP-5-8). Each row is the read's task mapped onto the board's row: the rank
// and its calc line, the stage and the due come from stored records. What the
// product does not store yet draws a dash or nothing and is recorded as such:
// the client's name (the client model), the estimate (MP-4-8), the comment
// counts (INB-1) and starring (P-20). The actual is the time logged (MP-4-6).

import { useState, type FormEvent, type ReactElement } from 'react';
import { Empty, ProjectsBoard, type BoardRow, type ProjectRow } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { rowActions } from './projects-row.ts';
import { titleOf } from '../views/task-title.ts';
import type {
  BoardTask,
  PersonListResult,
  TaskBoardResult,
} from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { useCommand } from '../records/use-command.ts';
import { pathTo } from '../routes.ts';

/** A create whose outcome is not known, held so the retry is the same attempt. */
interface PendingCreate {
  readonly operationId: string;
  readonly title: string;
}

export interface ProjectsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

export function Projects(props: ProjectsProps): ReactElement {
  const client = props.client;
  // While this is true the create is in flight and the form is not editable:
  // the input, the submit and `Start a different task` are all disabled. A
  // person who can type a second title during the first create is a person
  // whose second title a delayed success will wipe.
  //
  // `locked` adds `closed`: `task.create` is this form's one command, so a
  // refusal about this reader's authority closes the form rather than letting
  // it ask again, as the comment box and the propose form do.
  const { busy: creating, because, locked, run, reset } = useCommand();
  const [title, setTitle] = useState('');
  // The attempt whose outcome nobody knows. A create that ended `unavailable`
  // may well have committed on the server, so its identity and its exact
  // payload are kept here and presented again on the next submission. Minting
  // a fresh id instead would make the server's replay register unreachable and
  // the retry would create a second task.
  const [pending, setPending] = useState<PendingCreate | null>(null);

  const { state, reload } = useRead<TaskBoardResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', { board: null }),
    isEmpty: (value) => value.tasks.length === 0,
    deps: [],
  });

  // The people the assignee editor offers (MP-5-10); until they answer, the
  // assignee cell draws no editor.
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    // An answer without its list offers nobody, rather than breaking the board.
    isEmpty: (value) => !Array.isArray(value.persons) || value.persons.length === 0,
    deps: [],
  });
  const persons = people.state.outcome === 'ready' ? people.state.value.persons : null;

  // The same attempt while the asked-for task is the same one, a new attempt
  // when the person has changed what they are asking for. Retrying an unknown
  // outcome and deliberately starting a second task are different intentions
  // and the title is what tells them apart; `startNew` below says it outright.
  const attemptFor = (asked: string): PendingCreate =>
    pending !== null && pending.title === asked
      ? pending
      : { operationId: client.newOperationId(), title: asked };

  const onCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const asked = title.trim();
    if (locked || asked === '') return;
    const attempt = attemptFor(asked);
    setPending(attempt);
    run(
      // `board: null` is explicit. The acceptance case is a task with no board,
      // and leaving the field out would let a server default decide.
      () =>
        client.mutate(
          'task.create',
          { fields: { title: attempt.title }, board: null },
          { operationId: attempt.operationId },
        ),
      (settlement) => {
        // The one case the attempt is kept for. The task may or may not exist.
        if (settlement.kind === 'unknown') return;
        // Anything else is a known outcome and the attempt is over: a refusal
        // is a decision, and holding it would resend an identity the server
        // has settled.
        setPending(null);
        if (settlement.kind !== 'ok') return;
        // Clear only the text this create was for. The input is disabled while
        // the request is in flight so there should be nothing newer, but a
        // settlement that clears whatever happens to be in the box is the same
        // defect as the task form's: a late success erasing the next task's
        // title. Bind it to what was submitted and it cannot.
        setTitle((current) => (current.trim() === attempt.title ? '' : current));
        reload();
      },
    );
  };

  /** Abandon an unresolved attempt and ask for a genuinely different task. */
  const startNew = (): void => {
    setPending(null);
    reset();
    setTitle('');
  };

  const retrying = pending !== null && pending.title === title.trim();

  return (
    <div className="stack">
      <form className="taskform projects__create" onSubmit={onCreate}>
        <div className="field">
          <label className="tf__k" htmlFor="create-title">
            New task
          </label>
          <input
            id="create-title"
            className="input"
            type="text"
            required
            placeholder="What needs doing"
            disabled={locked}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </div>
        <button
          className="btn btn--primary"
          type="submit"
          data-attempt={retrying ? 'retry' : 'new'}
          disabled={locked || title.trim() === ''}
        >
          {creating ? 'Creating…' : retrying ? 'Retry create' : 'Create task'}
        </button>
        {pending === null ? null : (
          <button
            className="btn"
            type="button"
            data-attempt="discard"
            disabled={creating}
            onClick={startNew}
          >
            Start a different task
          </button>
        )}
        {because === null ? null : (
          <p className="field__error" role="alert" data-voice="input-wrong">
            {because}
          </p>
        )}
        {pending === null || because === null ? null : (
          <p className="card__sub" data-attempt="unresolved">
            This task may already have been created. Retrying sends the same attempt, so the server
            answers with the original result rather than making a second task.
          </p>
        )}
      </form>

      <RecordState
        state={state}
        subject="board"
        onRetry={reload}
        empty={
          <Empty
            title="No tasks on this board yet."
            description="You are permitted to see it and it has nothing in it."
            hint="Create one with the form above."
          />
        }
      >
        {(value) => (
          <ProjectsBoard
            rows={value.tasks.map((task) => rowOf(task))}
            withheld={value.withheld ?? 0}
            changedAt={value.changedAt ?? null}
            stages={[]}
            viewer={value.viewer ?? null}
            href={(row) => pathTo('agency:task-detail', { key: row.key })}
            actions={rowActions({
              client,
              tasks: value.tasks,
              people: persons,
              href: (key) => pathTo('agency:task-detail', { key }),
              reload,
            })}
            address={window.location.search}
            onAddress={(query) => {
              window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${query === '' ? '' : `?${query}`}`,
              );
            }}
          />
        )}
      </RecordState>
    </div>
  );
}

/** One task from the read as a Projects board row (MP-5-8). */
function rowOf(task: BoardTask): ProjectRow {
  return {
    id: task.id,
    key: task.key,
    name: titleOf(task.title),
    rank: { number: task.rank.number, calc: task.rank.calc },
    // No ticket builds starring yet, so the starred tier is empty (P-20).
    starred: false,
    // The client's name waits on the client model; `clientSet` says only
    // that there is one.
    client: null,
    assignee:
      task.assignee === null
        ? null
        : { id: task.assignee.personId, name: task.assignee.name, agent: false },
    due: task.due,
    completed: task.completedAt !== null,
    stage: task.stage,
    status: task.state?.label ?? 'No state',
    statusPosition: task.statePosition,
    // A run awaiting approval is the one wait the read carries; the banner
    // prints the mockup's word for it (B-21).
    waitReason: task.waitReason === 'needs_approval' ? 'approval' : null,
    // No task category is stored yet (it arrives with named board sections,
    // LEANS-ON), so no category chip draws.
    category: null,
    awaitingDecision: task.awaitingDecision,
    estimate: null,
    // The time logged on the task (MP-4-6); none logged draws a dash.
    actual: task.actualMinutes > 0 ? { kind: 'time', minutes: task.actualMinutes } : null,
    comments: { client: 0, mentions: 0, latest: null },
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Overdue, today or later, judged against the reader's own calendar day.
 *
 * The stored date part is the day the person picked in a local date input
 * (task/DetailsForm.tsx), so "today" is the local day too. Taking it from
 * `toISOString()` would be the UTC day, which in Australia lags the local one
 * for the first ten hours of every morning and draws yesterday's work as due
 * today.
 */
export function dueTone(iso: string | null, now: Date = new Date()): BoardRow['due'] {
  if (iso === null) return null;
  const today = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = iso.slice(0, 10);
  if (day < today) return 'past';
  return day === today ? 'today' : 'later';
}

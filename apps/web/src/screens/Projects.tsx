// SPDX-License-Identifier: AGPL-3.0-only
//
// `/projects/`. The board of the business's unboarded tasks, and the form that
// makes one.
//
// The read is `task.board` with `board: null`, which the contract defines as
// the business's unboarded tasks — the acceptance case creates a task
// **without a board** and expects to find it (B1).
//
// The board component is the ported one and it draws nine columns the slice
// does not yet store. Those cells draw a dash, which is the ported behaviour
// for "not set": the gap between what the mockup draws and what this build
// stores is recorded rather than papered over by dropping the columns.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Board, Empty, drawPinnedStepWord, type BoardRow, type DrawnState } from '@launchastro/ui';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import type { TaskBoardResult, TaskSummary } from '../operations/shapes.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { describeRefusal } from '../records/submit.ts';

export interface ProjectsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly onOpenTask: (key: string) => void;
}

export function Projects(props: ProjectsProps): ReactElement {
  const client = props.client;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [because, setBecause] = useState<string | null>(null);

  const { state, reload } = useRead<TaskBoardResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', { board: null }),
    isEmpty: (value) => value.tasks.length === 0,
    deps: [],
  });

  const onCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const asked = title.trim();
    if (asked === '') return;
    setCreating(true);
    setBecause(null);
    // `board: null` is explicit. The acceptance case is a task with no board,
    // and leaving the field out would let a server default decide.
    void (async () => {
      const result = await client.mutate('task.create', { fields: { title: asked }, board: null });
      setCreating(false);
      if (isRefusal(result)) {
        setBecause(describeRefusal(result));
        return;
      }
      if (isUnavailable(result)) {
        setBecause(result.because);
        return;
      }
      setTitle('');
      reload();
    })();
  };

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
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </div>
        <button
          className="btn btn--primary"
          type="submit"
          disabled={creating || title.trim() === ''}
        >
          {creating ? 'Creating…' : 'Create task'}
        </button>
        {because === null ? null : (
          <p className="field__error" role="alert" data-voice="input-wrong">
            {because}
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
          <Board
            rows={value.tasks.map((task) => rowOf(task))}
            groups={groupsOf(value.tasks)}
            filters={[{ kind: 'board', label: 'none' }]}
          />
        )}
      </RecordState>
    </div>
  );
}

/** One stored task as a board row. Everything the slice does not store is null. */
function rowOf(task: TaskSummary): BoardRow {
  return {
    id: task.id,
    rank: null,
    name: task.title,
    client: null,
    assignee: task.assignee?.name ?? null,
    dueLabel: task.due === null ? null : dayOf(task.due),
    due: dueTone(task.due),
    stage: null,
    state: stateOf(task),
    estimate: null,
    actual: null,
    group: task.state.label,
    href: `/task/${encodeURIComponent(task.key)}`,
  };
}

/**
 * The stored state as a drawn one.
 *
 * The label is the server's, because task states are preset records and the
 * label on the record is the word the installation chose. The tone comes from
 * the machine category through the ported projection, so a state the
 * installation adds still draws with a tone rather than falling through to
 * nothing.
 */
function stateOf(task: TaskSummary): DrawnState {
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

const groupsOf = (tasks: readonly TaskSummary[]): readonly string[] => [
  ...new Set(tasks.map((task) => task.state.label)),
];

const dayOf = (iso: string): string => iso.slice(0, 10);

function dueTone(iso: string | null): BoardRow['due'] {
  if (iso === null) return null;
  const today = new Date().toISOString().slice(0, 10);
  const day = iso.slice(0, 10);
  if (day < today) return 'past';
  return day === today ? 'today' : 'later';
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The subtask list on the Team side (MP-4-4, CS-4.25 to CS-4.27).
//
// Add through `task.create`; complete or reopen at the child's revision.
// Reread the parent's steps after a write, including its count and percentage.
// Gate steps have an eye and no tick, and stay counted until decided.
// Enter adds at the end and keeps focus and any newer draft. A lost answer's
// operation id is held for replay (#461).
//
// **Completed steps fold away.** The person's preference (`show-finished.ts`)
// keeps the fold open across a reread. Archived steps stay visible outside the
// fold and count, saying when and why, with no tick (DT-05).

import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { StepRow, StepCount } from './SubtaskRows.tsx';
import type { StepView, TaskTimeView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useShowFinished } from './show-finished.ts';
import { useCommand } from '../../records/use-command.ts';
import { stepMarks } from './perspective-counts.ts';
import { TeamWork, type PanelOpener } from './Perspectives.tsx';
import { TimeLog } from './Time.tsx';
import { holding, useHeldOperations } from './held-operations.ts';

const REOPEN_REASON = 'Unticked on the parent task’s subtask list.';
/** The add box's words where the page holds them above its read; the panel's box keeps its own. */
export const StepTitleHeld = createContext<readonly [string, (next: string) => void] | null>(null);

/** "1 of 2 done · 50%": the steps still in play, the archived ones left out. */
export function stepProgress(steps: readonly StepView[]): string {
  const counted = steps.filter((step) => step.archived === null);
  const done = counted.filter((step) => step.done).length;
  const percent = counted.length === 0 ? 0 : Math.round((done / counted.length) * 100);
  return `${String(done)} of ${String(counted.length)} done · ${String(percent)}%`;
}

const unfinished = (steps: readonly StepView[]): readonly StepView[] =>
  steps.filter((step) => step.archived === null && !step.done);

/** The box at the top of the list: Enter adds a step under this parent. */
function AddStep(props: {
  readonly client: OperationsClient;
  readonly parentId: string;
  readonly onChanged: () => void;
}): ReactElement {
  const { locked: busy, closed, because, run } = useCommand();
  const current = useSubtaskOwner(props.client, props.parentId);
  const own = useState('');
  const [title, setTitle] = use(StepTitleHeld) ?? own;
  const typed = useRef(title);
  typed.current = title;
  const box = useRef<HTMLInputElement>(null);
  const held = useHeldOperations();
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const wanted = title.trim();
    if (wanted === '' || busy) return;
    const body = { fields: { title: wanted }, parentId: props.parentId };
    const hold = holding(held, 'task.create', body, () => props.client.newOperationId());
    run(
      () => props.client.mutate('task.create', body, { operationId: hold.id }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (!current()) return;
        // A name typed since is the next one, not this one's to clear.
        if (settlement.kind === 'ok' && typed.current === title) setTitle('');
        if (settlement.kind === 'ok') props.onChanged();
        box.current?.focus();
      },
    );
  };
  return (
    <>
      <input
        ref={box}
        className="field__input"
        data-step-add
        disabled={closed}
        aria-label="Add a subtask"
        placeholder="Add a subtask and press Enter"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <StepError because={because} />
    </>
  );
}

function FinishedFold(props: {
  readonly count: number;
  readonly open: boolean;
  readonly onOpen: (value: boolean) => void;
}): ReactElement | null {
  if (props.count === 0) return null;
  return (
    <button
      type="button"
      className="btn btn--ghost"
      data-steps-finished
      aria-expanded={props.open}
      onClick={() => props.onOpen(!props.open)}
    >
      {props.open ? 'Hide finished' : `Show finished (${String(props.count)})`}
    </button>
  );
}

interface SubtaskListProps {
  readonly client: OperationsClient;
  readonly parentId: string;
  /** The composed Team heading carries this summary; standalone lists keep their own. */
  readonly showProgress?: boolean;
  readonly steps: readonly StepView[];
  readonly showFinished: boolean;
  readonly onShowFinished: (value: boolean) => void;
  readonly onChanged: () => void;
  readonly onOpenTask?: ((key: string) => void) | undefined;
}

export function SubtaskList(props: SubtaskListProps): ReactElement {
  const { client, steps, onOpenTask } = props;
  const { locked: busy, because, run } = useCommand();
  const current = useSubtaskOwner(props.client, props.parentId);
  const tick = (step: StepView): void => {
    const at = { expectedRevision: step.revision };
    run(
      () =>
        step.done
          ? client.mutate('task.reopen', { recordId: step.id, reason: REOPEN_REASON }, at)
          : client.mutate('task.complete', { recordId: step.id }, at),
      (settlement) => {
        if (current() && settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  const live = unfinished(steps);
  const archived = steps.filter((step) => step.archived !== null);
  const completed = steps.filter((step) => step.archived === null && step.done);
  const shown = [...live, ...archived, ...(props.showFinished ? completed : [])];
  return (
    <div className="sb__steplist" data-step-list>
      {steps.length === 0 || props.showProgress === false ? null : (
        <span className="card__sub" data-step-count>
          {stepProgress(steps)}
        </span>
      )}
      <AddStep client={client} parentId={props.parentId} onChanged={props.onChanged} />
      <ul className="sb__steps">
        {shown.map((step) => (
          <StepRow key={step.id} step={step} busy={busy} onTick={tick} onOpenTask={onOpenTask} />
        ))}
      </ul>
      {live.length === 0 && completed.length > 0 ? (
        <p className="card__sub" data-steps-empty>
          Nothing left on this one.
        </p>
      ) : null}
      <FinishedFold
        count={completed.length}
        open={props.showFinished}
        onOpen={props.onShowFinished}
      />
      <StepError because={because} />
    </div>
  );
}

interface TeamSubtasksProps {
  readonly client: OperationsClient;
  readonly task: {
    readonly id: string;
    readonly steps: readonly StepView[];
    readonly time: TaskTimeView | null;
    readonly estimateMinutes: number | null;
  };
  readonly showAllTime: boolean;
  readonly onShowAllTime: (value: boolean) => void;
  /** The fold, held above the page's read so a reread keeps it; the panel keeps its own. */
  readonly showFinished?: boolean | null;
  readonly onShowFinished?: (value: boolean | null) => void;
  readonly onChanged: () => void;
  readonly onTimer?: ((running: string | null) => void) | undefined;
  readonly onOpenPanel: PanelOpener | undefined;
  readonly onOpenTask?: ((key: string) => void) | undefined;
  /** False inside the dock task panel, where the edit already happens. */
  readonly doors?: boolean;
}

/** The Team side's subtask and time sections, each placed in it, as the task page draws them. */
export function TeamSubtasks(props: TeamSubtasksProps): ReactElement {
  const { task } = props;
  // The person's own choice (MP-4-4, CS-4.27). The member page and the panel
  // draw this; the shared view does not, so an outside reader reads nothing more.
  const [showFinished, setShowFinished] = useShowFinished(
    props.client,
    props.onShowFinished === undefined
      ? undefined
      : [props.showFinished ?? null, props.onShowFinished],
  );
  return (
    <TeamWork
      steps={stepMarks(task.steps)}
      progress={<StepCount value={task.steps.length === 0 ? null : stepProgress(task.steps)} />}
      list={
        <SubtaskList
          client={props.client}
          parentId={task.id}
          showProgress={false}
          steps={task.steps}
          showFinished={showFinished}
          onShowFinished={setShowFinished}
          onChanged={props.onChanged}
          onOpenTask={props.onOpenTask}
        />
      }
      // The burn bar draws against the task's own estimate, and waits while it has none.
      time={
        task.time === null ? undefined : (
          <TimeLog
            client={props.client}
            taskId={task.id}
            time={task.time}
            estimateMinutes={task.estimateMinutes}
            showAll={props.showAllTime}
            onShowAll={props.onShowAllTime}
            onChanged={props.onChanged}
            onTimer={props.onTimer}
          />
        )
      }
      onOpenPanel={props.onOpenPanel}
      doors={props.doors ?? true}
    />
  );
}

function useSubtaskOwner(client: OperationsClient, parentId: string): () => boolean {
  const held = useRef({ client, parentId, active: true });
  if (held.current.client !== client || held.current.parentId !== parentId) {
    held.current.active = false;
    held.current = { client, parentId, active: true };
  }
  const owner = held.current;
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return () => owner.active && held.current === owner;
}

function StepError(props: { readonly because: string | null }): ReactElement | null {
  return props.because === null ? null : (
    <p className="field__error" role="alert">
      {props.because}
    </p>
  );
}

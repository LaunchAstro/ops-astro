// SPDX-License-Identifier: AGPL-3.0-only
//
// The subtask list on the Team side (MP-4-4, CS-4.25 to CS-4.27).
//
// **A subtask is a task.** Adding one is `task.create` under this parent, and
// ticking one is the step's own lifecycle: `task.complete` to tick it,
// `task.reopen` with a reason to untick it, each at the step's revision. A
// success asks the page to read the task again, so the list, the count and
// the percentage are always the steps the server sent.
//
// **The box stays ready.** Enter adds and clears the box, and focus stays in
// it for the next one. The box sits at the top and a new step joins the end,
// in the order the server lists them.
//
// **Finished steps fold away.** A done step, and an archived one (it left the
// count without being done, MP-4-15), sit under "Show finished", which the
// page holds so a reread keeps it open. An archived step says when and why,
// and carries no tick: it comes back only when its parent is reopened.

import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { StepView, TaskTimeView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { stepMarks } from './perspective-counts.ts';
import { TeamWork, type PanelOpener } from './Perspectives.tsx';
import { TimeLog } from './Time.tsx';

const REOPEN_REASON = 'Unticked on the parent task’s subtask list.';

/** "1 of 2 done · 50%": the steps still in play, the archived ones left out. */
export function stepProgress(steps: readonly StepView[]): string {
  const counted = steps.filter((step) => step.archived === null);
  const done = counted.filter((step) => step.done).length;
  const percent = counted.length === 0 ? 0 : Math.round((done / counted.length) * 100);
  return `${String(done)} of ${String(counted.length)} done · ${String(percent)}%`;
}

const unfinished = (steps: readonly StepView[]): readonly StepView[] =>
  steps.filter((step) => step.archived === null && !step.done);

const archivedOn = (at: string): string =>
  new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Brisbane',
  });

function StepRow(props: {
  readonly step: StepView;
  readonly busy: boolean;
  readonly onTick: (step: StepView) => void;
}): ReactElement {
  const { step } = props;
  const press = (): void => {
    if (!props.busy) props.onTick(step);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    press();
  };
  const title = step.title ?? step.key;
  return (
    <li className="sb__step" data-step={step.id} data-done={step.done}>
      {step.archived === null ? (
        <span
          className="tpr__tick"
          role="checkbox"
          tabIndex={0}
          data-step-tick={step.id}
          aria-label={title}
          aria-checked={step.done}
          aria-disabled={props.busy}
          onClick={press}
          onKeyDown={onKeyDown}
        >
          {step.done ? '✓' : ''}
        </span>
      ) : null}
      <span className="sb__step-title">{title}</span>
      {step.archived === null ? null : (
        <span className="card__sub" data-step-archived>
          Archived {archivedOn(step.archived.at)} · {step.archived.why}
        </span>
      )}
    </li>
  );
}

/** The box at the top of the list: Enter adds a step under this parent. */
function AddStep(props: {
  readonly client: OperationsClient;
  readonly parentId: string;
  readonly onChanged: () => void;
}): ReactElement {
  const { busy, because, run } = useCommand();
  const [title, setTitle] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const wanted = title.trim();
    if (wanted === '' || busy) return;
    run(
      () =>
        props.client.mutate('task.create', {
          fields: { title: wanted },
          parentId: props.parentId,
        }),
      (settlement) => {
        if (settlement.kind === 'ok') {
          setTitle('');
          props.onChanged();
        }
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
        aria-label="Add a subtask"
        placeholder="Add a subtask and press Enter"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
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
      onClick={() => {
        props.onOpen(!props.open);
      }}
    >
      {props.open ? 'Hide finished' : `Show finished (${String(props.count)})`}
    </button>
  );
}

export function SubtaskList(props: {
  readonly client: OperationsClient;
  readonly parentId: string;
  readonly steps: readonly StepView[];
  readonly showFinished: boolean;
  readonly onShowFinished: (value: boolean) => void;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, steps } = props;
  const { busy, because, run } = useCommand();
  const tick = (step: StepView): void => {
    const at = { expectedRevision: step.revision };
    run(
      () =>
        step.done
          ? client.mutate('task.reopen', { recordId: step.id, reason: REOPEN_REASON }, at)
          : client.mutate('task.complete', { recordId: step.id }, at),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  const finished = steps.filter((step) => step.archived !== null || step.done);
  const shown = props.showFinished ? [...unfinished(steps), ...finished] : unfinished(steps);
  return (
    <div className="sb__steplist" data-step-list>
      {steps.length === 0 ? null : (
        <span className="card__sub" data-step-count>
          {stepProgress(steps)}
        </span>
      )}
      <AddStep client={client} parentId={props.parentId} onChanged={props.onChanged} />
      <ul className="sb__steps">
        {shown.map((step) => (
          <StepRow key={step.id} step={step} busy={busy} onTick={tick} />
        ))}
      </ul>
      <FinishedFold
        count={finished.length}
        open={props.showFinished}
        onOpen={props.onShowFinished}
      />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}

/** The Team side's subtask and time sections, each placed in it, as the task page draws them. */
export function TeamSubtasks(props: {
  readonly client: OperationsClient;
  readonly task: {
    readonly id: string;
    readonly steps: readonly StepView[];
    readonly time: TaskTimeView | null;
    readonly estimateMinutes: number | null;
  };
  readonly showFinished: boolean;
  readonly onShowFinished: (value: boolean) => void;
  readonly showAllTime: boolean;
  readonly onShowAllTime: (value: boolean) => void;
  readonly onChanged: () => void;
  readonly onOpenPanel: PanelOpener | undefined;
  /** False inside the dock task panel, where the edit already happens. */
  readonly doors?: boolean;
}): ReactElement {
  const { task } = props;
  return (
    <TeamWork
      steps={stepMarks(task.steps)}
      list={
        <SubtaskList
          client={props.client}
          parentId={task.id}
          steps={task.steps}
          showFinished={props.showFinished}
          onShowFinished={props.onShowFinished}
          onChanged={props.onChanged}
        />
      }
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
          />
        )
      }
      onOpenPanel={props.onOpenPanel}
      doors={props.doors ?? true}
    />
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// A recovered draft may retain elapsed time and Stop. Fresh timing requires a filed task.

import type { ReactElement } from 'react';
import { useTaskTimerSelection } from './task-timer-selection.tsx';
import { stopTimer, timedMinutes, type TaskDraft } from './task-draft.ts';
import { minutesText } from './Time.tsx';

const startedAt = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Brisbane',
  });

function DraftTimer(props: {
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  readonly locked: boolean;
}): ReactElement {
  const { draft, put } = props;
  const running = draft.timerFrom !== null;
  const select = useTaskTimerSelection();
  return (
    <div className="field">
      <button
        className="btn"
        type="button"
        data-draft="timer"
        disabled={props.locked || (!running && select === null)}
        onClick={() => {
          if (running) put(stopTimer(draft, Date.now()));
          else select?.();
        }}
      >
        {running ? 'Stop timer' : 'Select task to time'}
      </button>
      {running ? null : (
        <p className="card__sub">
          Select an existing task, or Create this task first, then start its timer.
        </p>
      )}
      {draft.timerFrom === null ? null : (
        <span className="card__sub" data-draft-timer-running>
          {' '}
          Running since {startedAt(draft.timerFrom)}
        </span>
      )}
      {timedMinutes(draft) > 0 ? (
        <p className="card__sub" data-draft-timer>
          Timed on this draft: {minutesText(timedMinutes(draft))}
        </p>
      ) : null}
    </div>
  );
}

/** The draft's time section: its timer, and time spent typed as the log box takes it. */
export function DraftTime(props: {
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  readonly locked: boolean;
}): ReactElement {
  const { draft, put, locked } = props;
  return (
    <>
      <DraftTimer draft={draft} put={put} locked={locked} />
      <div className="field">
        <label className="tf__k" htmlFor="panel-draft-time">
          Time spent
        </label>
        <input
          id="panel-draft-time"
          className="input"
          type="text"
          placeholder="30m"
          readOnly={locked}
          value={draft.time}
          onChange={(event) => {
            put({ time: event.target.value });
          }}
        />
      </div>
    </>
  );
}

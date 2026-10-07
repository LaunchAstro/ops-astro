// SPDX-License-Identifier: AGPL-3.0-only
//
// The timer on a new-task draft (MP-4-13, DN-05). The draft has no task yet,
// so its timer is the draft's own: Start keeps when it started with the
// draft, so a reload or Back keeps it running; Stop adds the time it ran to
// what the draft has timed. The minutes are rounded once, as `time.stop`
// rounds the task timer: up, never fewer than one, at most a day. Create stops a running timer and logs the timed
// minutes on the new task through `time.log` (`draft-parts.ts`), beside the
// time spent typed on the draft. The app
// strip's timer (MP-3-1) is drawn disabled until it is built.

import type { ReactElement } from 'react';
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
  return (
    <div className="field">
      <button
        className="btn"
        type="button"
        data-draft="timer"
        disabled={props.locked}
        onClick={() => {
          put(running ? stopTimer(draft, Date.now()) : { timerFrom: new Date().toISOString() });
        }}
      >
        {running ? 'Stop timer' : 'Start timer'}
      </button>
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

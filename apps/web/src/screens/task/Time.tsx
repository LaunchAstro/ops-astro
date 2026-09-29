// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6: the time section on the Team side (CS-4.1, CS-4.28 to CS-4.31).
//
// Everything drawn here is `task.read`'s `time`: the reader's own entries and
// running timer, and the task's total (RS-VAULT-9). Start and Stop drive the
// person's one timer through `time.start` and `time.stop`; the log box sends
// what was typed as `time.log` and the server parses it; a note edits inline
// by keyboard through `time.set_note`; an entry deletes through `time.delete`.
// After each, the page rereads rather than guessing the next state.

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { TaskTimeView, TimeEntryView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';

/** The entries shown before the fold (CS-4.31). */
const LATEST = 3;

/** "5m", "1h", "1h 30m". */
export function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)}m`;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

/** How far the total has burned into the estimate; danger only past it. None without one. */
export function burnOf(
  totalMinutes: number,
  estimateMinutes: number | null,
): { readonly percent: number; readonly danger: boolean } | null {
  if (estimateMinutes === null || estimateMinutes <= 0) return null;
  const percent = Math.min(100, Math.round((totalMinutes / estimateMinutes) * 100));
  return { percent, danger: totalMinutes > estimateMinutes };
}

const loggedOn = (at: string): string =>
  new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Brisbane',
  });

type Run = ReturnType<typeof useCommand>['run'];

function NoteBox(props: {
  readonly draft: string;
  readonly onDraft: (next: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}): ReactElement {
  return (
    <input
      className="field__input"
      data-time-note-edit
      aria-label="The entry’s note"
      value={props.draft}
      autoFocus
      onChange={(event) => {
        props.onDraft(event.target.value);
      }}
      onKeyDown={props.onKeyDown}
    />
  );
}

/** The note, a keyboard stop that opens an inline box: Enter saves, Escape leaves it. */
function EntryNote(props: {
  readonly entry: TimeEntryView;
  readonly run: Run;
  readonly client: OperationsClient;
  readonly onChanged: () => void;
}): ReactElement {
  const { entry } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const open = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setDraft(entry.note);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') setDraft(null);
    if (event.key !== 'Enter' || draft === null) return;
    event.preventDefault();
    props.run(
      () => props.client.mutate('time.set_note', { entryId: entry.id, note: draft }),
      (settlement) => {
        if (settlement.kind !== 'ok') return;
        setDraft(null);
        props.onChanged();
      },
    );
  };
  if (draft === null) {
    return (
      <span
        className="card__sub"
        role="button"
        tabIndex={0}
        data-time-note={entry.id}
        aria-label="Edit the note"
        onClick={() => {
          setDraft(entry.note);
        }}
        onKeyDown={open}
      >
        {entry.note === '' ? 'Add a note' : entry.note}
      </span>
    );
  }
  return <NoteBox draft={draft} onDraft={setDraft} onKeyDown={onKeyDown} />;
}

function EntryRow(props: {
  readonly entry: TimeEntryView;
  readonly busy: boolean;
  readonly run: Run;
  readonly client: OperationsClient;
  readonly onChanged: () => void;
}): ReactElement {
  const { entry } = props;
  const remove = (): void => {
    props.run(
      () => props.client.mutate('time.delete', { entryId: entry.id }),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return (
    <li className="sb__step" data-time-entry={entry.id}>
      <span className="sb__step-title">
        {entry.minutes === null ? 'Running' : minutesText(entry.minutes)} ·{' '}
        {loggedOn(entry.startedAt)}
      </span>
      <EntryNote {...props} />
      {entry.minutes === null ? null : (
        <button
          type="button"
          className="btn btn--ghost"
          data-time-delete={entry.id}
          disabled={props.busy}
          onClick={remove}
        >
          Delete
        </button>
      )}
    </li>
  );
}

/** What was typed, sent as `time.log` on Enter or Log; the server says whether it is a length of time. */
function LogBox(props: {
  readonly busy: boolean;
  readonly log: (duration: string, done: () => void) => void;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const send = (): void => {
    const duration = typed.trim();
    if (duration === '' || props.busy) return;
    props.log(duration, () => {
      setTyped('');
    });
  };
  return (
    <div className="sb__steplist">
      <input
        className="field__input"
        data-time-log
        aria-label="Log time"
        placeholder="1h 30m, 90m or 90"
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          send();
        }}
      />
      <button type="button" className="btn" data-time-log-add disabled={props.busy} onClick={send}>
        Log
      </button>
    </div>
  );
}

function Totals(props: { readonly total: number; readonly estimate: number | null }): ReactElement {
  const burn = burnOf(props.total, props.estimate);
  return (
    <>
      <span className="card__sub" data-time-total>
        {minutesText(props.total)} logged on this task
      </span>
      {burn === null ? null : (
        <div className="sb__burn" data-time-burn data-danger={burn.danger} aria-hidden="true">
          <span style={{ width: `${String(burn.percent)}%` }} />
        </div>
      )}
    </>
  );
}

function TimerButton(props: {
  readonly running: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="btn"
      data-timer
      data-running={props.running}
      aria-pressed={props.running}
      disabled={props.busy}
      onClick={props.onPress}
    >
      {props.running ? '■ Stop' : '▶ Start timer'}
    </button>
  );
}

/** The latest three, then every entry on request (CS-4.31); nothing to fold at three or fewer. */
function Fold(props: {
  readonly count: number;
  readonly open: boolean;
  readonly onOpen: (value: boolean) => void;
}): ReactElement | null {
  if (props.count <= LATEST) return null;
  return (
    <button
      type="button"
      className="btn btn--ghost"
      data-time-fold
      aria-expanded={props.open}
      onClick={() => {
        props.onOpen(!props.open);
      }}
    >
      {props.open ? 'Show latest three' : `Show all (${String(props.count)})`}
    </button>
  );
}

export function TimeLog(props: {
  readonly client: OperationsClient;
  readonly taskId: string;
  readonly time: TaskTimeView;
  readonly estimateMinutes: number | null;
  readonly showAll: boolean;
  readonly onShowAll: (value: boolean) => void;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, taskId, time } = props;
  const { busy, because, run } = useCommand();
  const after = (done?: () => void) => (settlement: { readonly kind: string }) => {
    if (settlement.kind !== 'ok') return;
    done?.();
    props.onChanged();
  };
  const timer = (): void => {
    const name = time.running === null ? 'time.start' : 'time.stop';
    run(() => client.mutate(name, { taskId }), after());
  };
  const log = (duration: string, done: () => void): void => {
    run(() => client.mutate('time.log', { taskId, duration }), after(done));
  };
  const shown = props.showAll ? time.entries : time.entries.slice(0, LATEST);
  return (
    <div className="sb__steplist" data-time-log-section>
      <TimerButton running={time.running !== null} busy={busy} onPress={timer} />
      <LogBox busy={busy} log={log} />
      <Totals total={time.totalMinutes} estimate={props.estimateMinutes} />
      <ul className="sb__steps">
        {shown.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            busy={busy}
            run={run}
            client={client}
            onChanged={props.onChanged}
          />
        ))}
      </ul>
      <Fold count={time.entries.length} open={props.showAll} onOpen={props.onShowAll} />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}

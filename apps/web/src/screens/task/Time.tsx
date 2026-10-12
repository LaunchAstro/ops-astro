// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6: the time section on the Team side (CS-4.1, CS-4.28 to CS-4.31).
//
// Everything drawn here is `task.read`'s `time`: the reader's own entries and running timer, and
// the task's total (RS-VAULT-9). Start and Stop drive the person's one timer through `time.start`
// and `time.stop`; the log box sends what was typed as `time.log` and the server parses it; a
// note edits inline by keyboard through `time.set_note`; an entry deletes through `time.delete`.
// After each, the page rereads rather than guessing the next state.

import { LATEST_TIME_ENTRIES, minutesText } from './time-format.ts';
import { Totals, Fold } from './TimeSummary.tsx';
import { TaskTimerButton } from './task-timer-context.tsx';
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { TaskTimeView, TimeEntryView } from '../../../../../packages/core-wire/src/index.ts';
import { useSignedInName } from '../../app-state.ts';
import { Avatar } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { holding, useHeldOperations, type Held } from './held-operations.ts';

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

/**
 * One held note per entry: the same words sent again after a lost answer go
 * under the held id; other words replace it, so a note typed back later is a
 * new save, never a replay of an earlier one's stored answer.
 */
function noteHold(held: Held, body: { entryId: string; note: string }, mint: () => string) {
  const slot = `time.set_note ${body.entryId}`;
  const words = `${slot} words`;
  const id = held[words] === body.note ? (held[slot] ?? mint()) : mint();
  held[slot] = id;
  held[words] = body.note;
  const settle = (kind: string): void => {
    if (kind === 'unknown' || held[slot] !== id) return;
    held[slot] = undefined;
    held[words] = undefined;
  };
  return { id, settle };
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
  const held = useHeldOperations();
  const open = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setDraft(entry.note);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') setDraft(null);
    if (event.key !== 'Enter' || draft === null) return;
    event.preventDefault();
    const body = { entryId: entry.id, note: draft };
    const hold = noteHold(held, body, () => props.client.newOperationId());
    props.run(
      () => props.client.mutate('time.set_note', body, { operationId: hold.id }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind !== 'ok') return;
        // Words typed while it was saving are not this answer's to close.
        setDraft((current) => (current === body.note ? null : current));
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
  const who = useSignedInName();
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
      {who === null ? <span aria-hidden="true" /> : <Avatar name={who} />}
      <span className="sb__step-title">{loggedOn(entry.startedAt)}</span>
      <EntryNote {...props} />
      <span className="ttime__duration">
        {entry.minutes === null ? 'Running' : minutesText(entry.minutes)}
      </span>
      {entry.minutes === null ? null : (
        <button
          type="button"
          className="row-remove"
          aria-label="Delete time entry"
          title="Delete time entry"
          data-time-delete={entry.id}
          disabled={props.busy}
          onClick={remove}
        >
          ×
        </button>
      )}
    </li>
  );
}

/** What was typed, as `time.log`, which the server parses; a lost answer's id is kept for the same box. */
function LogBox(props: {
  readonly busy: boolean;
  readonly mint: () => string;
  readonly log: (duration: string, operationId: string, then: (kind: string) => void) => void;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const held = useHeldOperations();
  const send = (): void => {
    const duration = typed.trim();
    if (duration === '' || props.busy) return;
    const hold = holding(held, 'time.log', duration, props.mint);
    props.log(duration, hold.id, (kind) => {
      hold.settle(kind);
      if (kind === 'ok') setTyped((now) => (now === typed ? '' : now));
    });
  };
  return (
    <div className="ttime__log">
      <input
        className="field__input"
        data-time-log
        aria-label="Log time"
        placeholder={'eg "1h 30m"'}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
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

function timerTask(props: {
  readonly taskId: string;
  readonly taskKey?: string;
  readonly taskTitle?: string | null;
}) {
  return {
    id: props.taskId,
    ...(props.taskKey === undefined ? {} : { key: props.taskKey }),
    ...(props.taskTitle === undefined ? {} : { title: props.taskTitle }),
  };
}

interface TimeLogProps {
  readonly client: OperationsClient;
  readonly taskId: string;
  readonly taskKey?: string;
  readonly taskTitle?: string | null;
  readonly time: TaskTimeView;
  readonly estimateMinutes: number | null;
  readonly showAll: boolean;
  readonly onShowAll: (value: boolean) => void;
  readonly onChanged: () => void;
}

export function TimeLog(props: TimeLogProps): ReactElement {
  const { client, taskId, time } = props;
  const { busy, because, run } = useCommand();
  const after = (done?: (kind: string) => void) => (settlement: { readonly kind: string }) => {
    done?.(settlement.kind);
    if (settlement.kind === 'ok') props.onChanged();
  };
  const log = (duration: string, operationId: string, done: (kind: string) => void): void =>
    run(() => client.mutate('time.log', { taskId, duration }, { operationId }), after(done));
  const shown = props.showAll ? time.entries : time.entries.slice(0, LATEST_TIME_ENTRIES);
  return (
    <div className="sb__steplist" data-time-log-section>
      <Totals total={time.totalMinutes} estimate={props.estimateMinutes} />
      <TimeControls
        task={timerTask(props)}
        busy={busy}
        taskId={taskId}
        mint={() => client.newOperationId()}
        log={log}
      />
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

function TimeControls(props: {
  readonly task: ReturnType<typeof timerTask>;
  readonly busy: boolean;
  readonly taskId: string;
  readonly mint: () => string;
  readonly log: (duration: string, operationId: string, done: (kind: string) => void) => void;
}): ReactElement {
  const { busy, taskId, log } = props;
  return (
    <div className="ttime__controls">
      <div className="ttime__timer">
        <span className="ttime__label">Timer</span>
        <TaskTimerButton task={props.task} busy={busy} />
      </div>
      <div className="ttime__logging">
        <span className="ttime__label">Log time</span>
        <LogBox key={taskId} busy={busy} mint={props.mint} log={log} />
      </div>
    </div>
  );
}

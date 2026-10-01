// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger's face (MP-8-4, CS-8.9): what happened to the tasks a
// reader can see, newest first, under a sticky head per day, and paged by
// whole days with "Load earlier days" (R49). It draws what the ledger read
// returned and reads nothing itself; a row opens its task beside the ledger.

import type { MouseEvent, ReactElement } from 'react';
import { Empty } from '../primitives/Absence.tsx';

export interface LedgerEvent {
  readonly id: string;
  readonly at: string;
  readonly actorName: string;
  /** The command that was applied, by its surface name. */
  readonly operation: string;
  readonly task: { readonly key: string; readonly title: string | null };
}

/** One day in the reader's zone, and every event on it: a page never splits a day. */
export interface LedgerDay {
  /** `YYYY-MM-DD` in the reader's zone. */
  readonly day: string;
  readonly events: readonly LedgerEvent[];
}

export interface LedgerProps {
  readonly days: readonly LedgerDay[];
  /** Whether the read has days before the last one drawn. */
  readonly earlier: boolean;
  readonly loading: boolean;
  /** `YYYY-MM-DD` in the reader's zone, for Today and Yesterday. */
  readonly today: string;
  /** The zone the read grouped the days in, and the times are drawn in. */
  readonly timeZone: string;
  readonly taskHref: (key: string) => string;
  /** Opens the task beside the ledger. */
  readonly onOpenTask: (key: string) => void;
  readonly onLoadEarlier: () => void;
}

const KIND: Readonly<Record<string, string>> = {
  'task.create': 'Created',
  'task.update': 'Updated',
  'task.complete': 'Completed',
  'task.reopen': 'Reopened',
  'task.comment': 'Commented',
  'task.propose': 'Proposed',
  'task.decide': 'Decided',
  'task.pickup': 'Picked up',
  'task.handback': 'Handed back',
  'task.start': 'Started',
  'task.assign': 'Assigned',
  'task.triage': 'Triaged',
  'task.set_stage': 'Stage set',
  'task.set_party': 'Client set',
  'task.set_audience': 'Audience set',
  'task.reparent': 'Moved under',
  'task.move': 'Moved',
  'task.rank': 'Reordered',
  'task.trash': 'Trashed',
  'task.restore': 'Restored',
  'task.purge': 'Purged',
  'task.cancel': 'Cancelled',
  'task.restart': 'Restarted',
};

/** A command with no word here still reads as a change, never as its code name. */
const kindOf = (operation: string): string =>
  Object.hasOwn(KIND, operation) ? (KIND[operation] ?? 'Changed') : 'Changed';

function parts(date: Date, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of new Intl.DateTimeFormat('en-AU', options).formatToParts(date)) {
    found.set(part.type, part.value);
  }
  return found;
}

const noon = (day: string): Date => new Date(`${day}T12:00:00Z`);

// Fixed words, so a label reads the same whatever locale data the runtime has.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const yesterday = new Date(noon(today).getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return 'Yesterday';
  const date = noon(day);
  return `${WEEKDAYS[date.getUTCDay()] ?? ''} ${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''}`;
}

function timeOf(at: string, timeZone: string): string {
  const found = parts(new Date(at), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${found.get('hour') ?? ''}:${found.get('minute') ?? ''}`;
}

/** A plain primary press opens the task here; anything else is the browser's. */
const plain = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function Row(props: { readonly event: LedgerEvent; readonly ledger: LedgerProps }): ReactElement {
  const { event, ledger } = props;
  const open = (press: MouseEvent): void => {
    if (!plain(press)) return;
    press.preventDefault();
    ledger.onOpenTask(event.task.key);
  };
  // A press on the link is the link's; the row takes only the rest of itself.
  const openRow = (press: MouseEvent<HTMLDivElement>): void => {
    if (press.target instanceof Element && press.target.closest('a') !== null) return;
    open(press);
  };
  return (
    // The task link is the keyboard's way in; a press anywhere else on the
    // row is the same plain open, for a pointer.
    <div className="act__row" data-event={event.id} onClick={openRow}>
      <span className="act__t">{timeOf(event.at, ledger.timeZone)}</span>
      <span className="act__kind">{kindOf(event.operation)}</span>
      <span className="act__who">{event.actorName}</span>
      <span className="act__body">
        <span className="act__text">{event.task.title ?? event.task.key}</span>
        <a className="act__proj" href={ledger.taskHref(event.task.key)} onClick={open}>
          {event.task.key}
        </a>
      </span>
    </div>
  );
}

export function Ledger(props: LedgerProps): ReactElement {
  if (props.days.length === 0) {
    return (
      <Empty
        title="Nothing has happened here yet."
        description="Every change to a task you can see is listed here, newest first."
      />
    );
  }
  return (
    <div className="act">
      <div className="act__list">
        {props.days.map((day) => (
          <section
            key={day.day}
            className="act__daygrp"
            aria-label={dayLabel(day.day, props.today)}
          >
            <h3 className="act__day">{dayLabel(day.day, props.today)}</h3>
            {day.events.map((event) => (
              <Row key={event.id} event={event} ledger={props} />
            ))}
          </section>
        ))}
      </div>
      {props.earlier ? (
        <button
          type="button"
          className="btn btn--secondary btn--sm act__more"
          disabled={props.loading}
          aria-busy={props.loading}
          onClick={props.onLoadEarlier}
        >
          Load earlier days
        </button>
      ) : null}
    </div>
  );
}

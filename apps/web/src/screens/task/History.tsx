// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's history (MP-4-16, DT-22, TT-05): what the server recorded
// happening to the task, oldest first as it sent it.
//
// **Transitions only.** `task.read`'s history is the changes applied to the
// task (`HISTORY_OPERATIONS`): no comments, notes or time, which the server
// leaves out. A change names the fields it set where its event recorded them,
// "Due date and priority changed", and its command's words where not.
//
// **The head reads the latest change**: how long ago, who, and what. The page
// shows the whole trail open; the dock task panel folds it (MP-4-8), and
// whether it shows is the person's own `history.showTrail` preference
// (`useShowTrail`), read by the panel above its task read. With no change the head
// has nothing after it and the page says so.
//
// Who is the person's name the read carries for a person's actor, and "An
// agent" or "The system" for the other two kinds (`whoOf`).

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import {
  HISTORY_FIELDS,
  HISTORY_OPERATIONS,
  type InternalTaskDetail as Task,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useSavedFlag } from './saved-flag.ts';

export const SHOW_TRAIL = 'history.showTrail';

/** Whether the panel's trail shows: the person's own key, folded by default. */
export const useShowTrail = (
  client: OperationsClient,
): readonly [boolean, (open: boolean) => void] => useSavedFlag(client, SHOW_TRAIL);

type Entry = Task['history'][number];

const MINUTE = 60_000;
const UNITS: readonly (readonly [number, string])[] = [
  [24 * 60 * MINUTE, 'day'],
  [60 * MINUTE, 'hour'],
  [MINUTE, 'minute'],
];

/** How long ago, in whole units, from the reader's clock. */
function ago(at: string, now: number): string {
  const elapsed = now - Date.parse(at);
  for (const [size, unit] of UNITS) {
    const count = Math.floor(elapsed / size);
    if (count >= 1) return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** The fields a change set, "Due date and priority changed", or what its command did. */
function whatOf(entry: Entry): string {
  const labels = (entry.changed ?? []).flatMap((key) => HISTORY_FIELDS[key] ?? []);
  const [first, ...rest] = labels;
  if (first === undefined) return HISTORY_OPERATIONS[entry.operation] ?? 'Changed';
  const named = [first, ...rest.map((label) => label.toLowerCase())];
  const last = named.pop() ?? '';
  return `${named.length === 0 ? last : `${named.join(', ')} and ${last}`} changed`;
}

/**
 * Who made a change, in words (MP-4-16): a person by name, an agent and the
 * system as what they are. An actor identifier is never drawn: it means
 * nothing to a person reading the page. `?? null`: a task read from a server
 * that predates the names carries neither field.
 */
const whoOf = (entry: Entry): string => {
  const kind = entry.actorKind ?? null;
  if (kind === 'agent') return 'An agent';
  if (kind === 'worker') return 'The system';
  return entry.actorName ?? 'Someone';
};

export function History(props: {
  readonly history: Task['history'];
  /**
   * The dock task panel folds the trail behind "Show all N changes" (MP-4-16):
   * whether it shows, and the change, from `useShowTrail`. Absent, it is open.
   */
  readonly fold?: readonly [boolean, (open: boolean) => void];
}): ReactElement | null {
  const now = Date.now();
  // An older server sent comments in the history too; they are not changes.
  const changes = props.history.filter((entry) =>
    Object.hasOwn(HISTORY_OPERATIONS, entry.operation),
  );
  // The panel draws no history at all until something has changed (MP-4-16).
  if (props.fold !== undefined && changes.length === 0) return null;
  const latest = changes.at(-1);
  const open = props.fold?.[0] ?? true;
  return (
    <section className="sb__sect" data-history>
      <div className="sb__sh">
        <span className="sb__k">History</span>
        {latest === undefined ? null : (
          <span className="sb__meta" data-history="latest">
            {`${ago(latest.at, now)} · ${whoOf(latest)} · ${whatOf(latest)}`}
          </span>
        )}
      </div>
      {changes.length === 0 ? (
        <div data-history="empty">
          <Empty look="inline" title="Nothing has changed on this one yet." />
        </div>
      ) : null}
      {changes.length === 0 || props.fold === undefined ? null : (
        <TrailFold open={open} count={changes.length} onToggle={props.fold[1]} />
      )}
      {changes.length === 0 || !open ? null : (
        <div className="sbact" data-history="trail">
          {changes.map((entry, index) => (
            <div className="sbact__row" key={entry.eventId ?? String(index)}>
              <span className="sbact__meta">
                {ago(entry.at, now)} · {whoOf(entry)}
              </span>
              <span className="sb__state">{whatOf(entry)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The panel's fold: "Show all N changes" while folded, "Hide the trail" while open. */
function TrailFold(props: {
  readonly open: boolean;
  readonly count: number;
  readonly onToggle: (open: boolean) => void;
}): ReactElement {
  return (
    <button
      className="tt__more"
      type="button"
      data-history-fold={props.open ? 'open' : 'folded'}
      aria-expanded={props.open}
      onClick={() => {
        props.onToggle(!props.open);
      }}
    >
      {props.open ? 'Hide the trail' : `Show all ${String(props.count)} changes`}
    </button>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's history (MP-4-16, DT-22, TT-05): what the server recorded
// happening to the task, oldest first as it sent it.
//
// **Transitions only.** `task.read`'s history is every applied write on the
// task's own address, and a comment is one of them. A comment is the
// conversation's, not a change to the task, so it is neither the latest change
// nor a row of the trail here.
//
// **The head reads the latest change**: how long ago, who, and what. The page
// shows the whole trail open; the dock task panel folds it (MP-4-8). With no
// change the head has nothing after it and the page says so.
//
// Who is the person's name the read carries for a person's actor, and "An
// agent" or "The system" for the other two kinds (`whoOf`).

import type { ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';

type Entry = Task['history'][number];

/** Writes that are conversation, not a change to the task. */
const NOT_TRANSITIONS: ReadonlySet<string> = new Set(['task.comment']);

/** What each change is, in the words a person reads. Anything else is shown as sent. */
const WHAT: Readonly<Record<string, string>> = {
  'task.create': 'Created',
  'task.update': 'Details changed',
  'task.assign': 'Assigned',
  'task.start': 'Started',
  'task.complete': 'Completed',
  'task.reopen': 'Reopened',
  'task.set_stage': 'Stage set',
  'task.set_party': 'Client set',
  'task.set_audience': 'Audience set',
  'task.set_scores': 'Rank marks set',
  'task.set_adhoc': 'Ad hoc changed',
  'task.share_with_client': 'Shared with the client',
  'task.revoke_client_share': 'Client access withdrawn',
  'task.propose': 'Proposed',
  'task.decide': 'Decided',
  'task.trash': 'Moved to the bin',
  'task.restore': 'Restored',
};

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

const whatOf = (entry: Entry): string => WHAT[entry.operation] ?? entry.operation;

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

export function History(props: { readonly history: Task['history'] }): ReactElement {
  const now = Date.now();
  const changes = props.history.filter((entry) => !NOT_TRANSITIONS.has(entry.operation));
  const latest = changes.at(-1);
  return (
    <section className="sb__sect" data-history>
      <div className="sb__sh">
        <span className="sb__k">History</span>
        {latest === undefined ? null : (
          <span className="sbact__meta" data-history="latest">
            {`${ago(latest.at, now)} · ${whoOf(latest)} · ${whatOf(latest)}`}
          </span>
        )}
      </div>
      {changes.length === 0 ? (
        <div data-history="empty">
          <PaneEmpty say="Nothing has changed on this one yet." />
        </div>
      ) : (
        <div className="sbact" data-history="trail">
          {changes.map((entry, index) => (
            <div className="sbact__row" key={`${entry.at}-${String(index)}`}>
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

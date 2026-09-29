// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's outage (T3e2): the one report of the outage that dropped
// this task's work, read from `task.queue`, the team's view. It names the
// cause in the drop's own words (never a cancellation), whose fault it was,
// its window, and how many of the runs it dropped came back. Reports that do
// not name this task are not drawn; a reader the queue refuses sees none.

import type { ReactElement } from 'react';
import { drawRunState } from '@launchastro/ui';
import type { ReadState } from '../../data/authorised-read.ts';
import type { QueueResult } from '../../../../../packages/core-wire/src/index.ts';

const FAULT: Readonly<Record<string, string>> = {
  provider: "the provider's fault",
  network: "the network's fault",
  ours: 'our fault',
};

export function Outages(props: {
  readonly state: ReadState<QueueResult>;
  readonly taskId: string;
}): ReactElement | null {
  const value = props.state.outcome === 'ready' ? props.state.value : null;
  const mine = (value?.outages ?? []).filter((one) =>
    one.runs.some((run) => run.taskId === props.taskId),
  );
  if (mine.length === 0) return null;
  return (
    <section className="sb__sect" data-outages="some">
      <div className="sb__sh">
        <span className="sb__k">Outage</span>
      </div>
      <div className="sbact">
        {mine.map((one) => (
          <div className="sbact__row" key={one.id} data-outage={one.id}>
            <span className="sb__state">
              {drawRunState({ state: 'waiting', waitReason: `dropped_${one.cause}` }).word},{' '}
              {FAULT[one.fault] ?? one.fault}
            </span>
            <span className="sbact__meta">
              {one.openedAt} to {one.closedAt ?? `${one.lastDropAt}, still open`} ·{' '}
              {one.runs.length} runs dropped, {one.runs.filter((run) => run.reactivated).length}{' '}
              came back
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

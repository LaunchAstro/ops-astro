// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's history: what the server recorded, oldest first as it sent it.

import type { ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { TaskDetail as Task } from '../../operations/shapes.ts';

export function History(props: { readonly history: Task['history'] }): ReactElement {
  return (
    <section className="sb__sect">
      <div className="sb__sh">
        <span className="sb__k">History</span>
      </div>
      {props.history.length === 0 ? (
        <PaneEmpty say="Nothing has changed on this one yet." />
      ) : (
        <div className="sbact">
          {props.history.map((entry, index) => (
            <div className="sbact__row" key={`${entry.at}-${String(index)}`}>
              <span className="sbact__meta">
                {entry.at} · {entry.actorId}
              </span>
              <span className="sb__state">{entry.operation}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

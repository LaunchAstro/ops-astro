// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's state revision lists (CS-16.4): the shown run's current knowledge
// and unknowns, its newest kept version, and the earlier versions below. The
// text is the writer's, a person's or the agent's, and is drawn as text only.
// Nothing activates from it in version 1 (RA-10); the pane writes nothing.

import type { ReactElement } from 'react';
import type { LedgerRunState } from '../../state/token-ledger.ts';

export function RunKnowledge(props: {
  readonly runId: string | null;
  readonly states: readonly LedgerRunState[] | undefined;
}): ReactElement | null {
  const versions = (props.states ?? []).filter((each) => each.runId === props.runId);
  const [current, ...earlier] = versions;
  if (current === undefined) return null;
  return (
    <div className="sb__sect" data-agent="knowledge" data-knowledge-version={current.version}>
      <div className="sb__sh">
        <span className="sb__k">What the run knows</span>
        <span className="sbact__meta">{`Version ${current.version}`}</span>
      </div>
      <ul>
        {current.knowledge.map((item, index) => (
          <li key={index} data-knowledge="item">
            {item}
          </li>
        ))}
      </ul>
      {current.unknowns.length === 0 ? null : (
        <>
          <span className="sb__k">Still unknown</span>
          <ul>
            {current.unknowns.map((item, index) => (
              <li key={index} data-knowledge="unknown">
                {item}
              </li>
            ))}
          </ul>
        </>
      )}
      {earlier.map((each) => (
        <p
          key={each.version}
          className="sbact__meta"
          data-knowledge="revision"
          data-version={each.version}
        >
          {`Version ${each.version}, revised ${each.revisedAt.slice(0, 16).replace('T', ' ')}`}
        </p>
      ))}
    </div>
  );
}

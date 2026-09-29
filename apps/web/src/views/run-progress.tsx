// SPDX-License-Identifier: AGPL-3.0-only
//
// The run on the task page (T2g, product issue 15): what `task.execution`
// reports, each run on its own and never merged into a current one.
//
// **Six outcomes, six drawings.** Loading, no run, denied, unavailable, stale
// and ready each stamp their own `data-outcome`, and only `no-run` says there
// is nothing: a refused or failed read is never an empty list, because that
// would tell a person no work happened when the page simply could not see it.
// A state the projection does not know prints raw at the waiting tone
// (`drawRunState`'s fallback), never dropped.

import type { ReactElement } from 'react';
import { drawRunState, Empty, PaneEmpty, Spill } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  ExecutionRun,
  ExecutionEvent,
  TaskExecutionResult,
} from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';

export interface RunProgressProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskKey: string;
  /**
   * The task read's latest answer. The page's one live channel re-reads the
   * task, and each new answer re-reads the run with it, so no second stream.
   */
  readonly readOf: unknown;
}

export function RunProgress(props: RunProgressProps): ReactElement {
  const { client, taskKey } = props;
  const { state } = useRead<TaskExecutionResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskExecutionResult>('task.execution', { recordId: taskKey }),
    deps: [taskKey, props.readOf],
  });
  const value = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  // An answer without the run list is not one this page can read, so it draws
  // as unavailable rather than as no run.
  const readable = value !== null && Array.isArray(value.runs) && Array.isArray(value.events);
  const outcome = value === null ? state.outcome : readable ? value.outcome : 'unavailable';
  return (
    <section className="sb__sect" data-outcome={outcome} data-run-progress="">
      <div className="sb__sh">
        <span className="sb__k">The run</span>
      </div>
      {state.outcome === 'loading' ? (
        <PaneEmpty say="Reading the run…" />
      ) : state.outcome === 'denied' ? (
        <p className="card__sub" data-run="denied">
          The server refused this read ({state.refusal.code}), so nothing about the run is shown.
        </p>
      ) : state.outcome === 'unavailable' || !readable ? (
        <p className="card__sub" data-run="unavailable">
          The run could not be read
          {state.outcome === 'unavailable' ? `: ${state.because}` : ''}. That is not a claim that no
          work ran.
        </p>
      ) : state.value.outcome === 'no-run' ? (
        <Empty title="No run yet" description="Nothing has been picked up on this task." />
      ) : (
        <>
          {state.value.outcome === 'stale' ? (
            <p className="card__sub" data-run="stale">
              This page is behind the run's record; it reads again when the record moves.
            </p>
          ) : null}
          {state.value.runs.map((run) => (
            <Run events={state.value.events} key={run.runId} run={run} />
          ))}
        </>
      )}
    </section>
  );
}

function Run(props: {
  readonly run: ExecutionRun;
  readonly events: readonly ExecutionEvent[];
}): ReactElement {
  const { run } = props;
  return (
    <div className="stack" data-run-id={run.runId}>
      <div className="sb__sh">
        <Spill state={drawRunState({ state: run.state, waitReason: null })} />
        <span className="sbact__meta">run {run.runId}</span>
      </div>
      <div className="sbact">
        {props.events
          .filter((event) => event.runId === run.runId)
          .map((event) => (
            <div className="sbact__row" data-event-kind={event.kind} key={event.eventId}>
              <span className="sbact__meta">{event.at}</span>
              <span className="sb__state">{event.kind}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

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
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../operations/client.ts';
import type {
  ExecutionRun,
  ExecutionEvent,
  ReceiptResult,
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
    run: async () => await wholeExecution(client, taskKey),
    deps: [taskKey, props.readOf],
  });
  const value =
    state.outcome === 'ready' || state.outcome === 'empty' ? (state.value.execution ?? null) : null;
  // An answer without the run list is not one this page can read, so it draws
  // as unavailable rather than as no run.
  const settledRead = state.outcome === 'ready' || state.outcome === 'empty';
  const readable = value !== null && Array.isArray(value.runs) && Array.isArray(value.events);
  const outcome = !settledRead ? state.outcome : readable ? value.outcome : 'unavailable';
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
      ) : value === null ? null : value.outcome === 'no-run' ? (
        <Empty title="No run yet" description="Nothing has been picked up on this task." />
      ) : (
        <>
          {value.outcome === 'stale' ? (
            <p className="card__sub" data-run="stale">
              This page is behind the run's record; it reads again when the record moves.
            </p>
          ) : null}
          {value.runs.map((run) => (
            <Run
              client={client}
              events={value.events}
              grantKey={props.grantKey}
              key={run.runId}
              readOf={props.readOf}
              run={run}
            />
          ))}
        </>
      )}
    </section>
  );
}

/**
 * Every page of `task.execution`, followed through `next` until the answer is
 * complete (a page holds at most 200 events), so event 201 is never dropped.
 * The events are joined in order; the runs and the outcome are the last
 * page's, which is the newest reading. A refusal or an outage on any page is
 * the answer, never a partial run. A `next` that does not move forward ends
 * the walk rather than asking for the same page again, and so does an answer
 * that carries no `next` at all.
 */
async function wholeExecution(
  client: OperationsClient,
  recordId: string,
): Promise<CallResult<TaskExecutionResult>> {
  let answer = await client.read<TaskExecutionResult>('task.execution', { recordId });
  const events: ExecutionEvent[] = [];
  let cursor = 0;
  for (;;) {
    if (isRefusal(answer) || isUnavailable(answer)) return answer;
    const page = answer.value.execution;
    if (page === undefined || !Array.isArray(page.events)) return answer;
    events.push(...page.events);
    if (page.complete === true || typeof page.next !== 'number' || page.next <= cursor) {
      return { ok: true, value: { execution: { ...page, events } } };
    }
    cursor = page.next;
    // One page at a time: each asks from where the last one ended.
    // eslint-disable-next-line no-await-in-loop
    answer = await client.read<TaskExecutionResult>('task.execution', { recordId, cursor });
  }
}

function Run(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly readOf: unknown;
  readonly run: ExecutionRun;
  readonly events: readonly ExecutionEvent[];
}): ReactElement {
  const { run } = props;
  const mine = props.events.filter((event) => event.runId === run.runId);
  const attempts = [...new Set(mine.map((event) => event.attemptId))];
  return (
    <div className="stack" data-run-id={run.runId}>
      <div className="sb__sh">
        <Spill state={drawRunState({ state: run.state, waitReason: null })} />
        <span className="sbact__meta">run {run.runId}</span>
      </div>
      <div className="sbact">
        {mine.map((event) => (
          <div className="sbact__row" data-event-kind={event.kind} key={event.eventId}>
            <span className="sbact__meta">{event.at}</span>
            <span className="sb__state">{event.kind}</span>
          </div>
        ))}
      </div>
      {attempts.map((attemptId) => (
        <AttemptReceipt
          attemptId={attemptId}
          client={props.client}
          grantKey={props.grantKey}
          key={attemptId}
          readOf={props.readOf}
        />
      ))}
    </div>
  );
}

/**
 * The receipt of one attempt: the approval it came from, the version, the
 * effect, and the money line (held, spent, released). It carries no undo
 * control. An attempt not yet observed has no receipt, and says so.
 */
function AttemptReceipt(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly readOf: unknown;
  readonly attemptId: string;
}): ReactElement | null {
  const { client, attemptId } = props;
  const { state } = useRead<ReceiptResult>({
    grantKey: props.grantKey,
    run: () => client.read<ReceiptResult>('task.receipt', { attemptId }),
    deps: [attemptId, props.readOf],
  });
  if (state.outcome === 'loading') return null;
  if (state.outcome !== 'ready' && state.outcome !== 'empty') {
    return (
      <p className="card__sub" data-receipt="none" data-receipt-attempt={attemptId}>
        No receipt for attempt {attemptId} yet: its effect has not been observed.
      </p>
    );
  }
  const { receipt } = state.value;
  const { settlement } = receipt;
  return (
    <div
      className="card__sub"
      data-receipt-attempt={attemptId}
      data-receipt-decision={receipt.decision.id}
    >
      Receipt: approved by decision {receipt.decision.id} on version {receipt.version.number}; the
      effect was a{' '}
      {receipt.effect.audience === 'internal' ? 'team-only comment' : receipt.effect.kind}.{' '}
      <span data-money={settlement.state}>
        {'spentMinor' in settlement
          ? `held ${amount(settlement.heldMinor)} · spent ${amount(settlement.spentMinor)} · released ${amount(settlement.releasedMinor)}`
          : `held ${amount(settlement.heldMinor)} · ${settlement.state.replaceAll('_', ' ')}`}
      </span>
    </div>
  );
}

function amount(minor: number): string {
  return (minor / 100).toFixed(2);
}

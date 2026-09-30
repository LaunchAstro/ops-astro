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
  ExecutionNode,
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
  const outcome = settledRead ? (readable ? value.outcome : 'unavailable') : state.outcome;
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
        <Runs client={client} grantKey={props.grantKey} readOf={props.readOf} value={value} />
      )}
    </section>
  );
}

/** The run's record: a note when this page is behind it, then each run. */
function Runs(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly readOf: unknown;
  readonly value: NonNullable<TaskExecutionResult['execution']>;
}): ReactElement {
  const { value } = props;
  return (
    <>
      {value.outcome === 'stale' ? (
        <p className="card__sub" data-run="stale">
          This page is behind the run's record; it reads again when the record moves.
        </p>
      ) : null}
      {value.runs.map((run) => (
        <Run
          client={props.client}
          events={value.events}
          grantKey={props.grantKey}
          key={run.runId}
          node={value.graph?.nodes.find((each) => each.nodeId === run.runId)}
          readOf={props.readOf}
          run={run}
        />
      ))}
    </>
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
  readonly node: ExecutionNode | undefined;
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
      {props.node === undefined ? null : <Observed node={props.node} />}
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
 * The run's observed layer (AW-06): what its record says happened, in words.
 * Silence is not a verdict (a quiet run reads in progress until something
 * recorded moves it), and money nobody recorded reads as not recorded, never 0.
 * The planned layer waits on the bound plan record, so nothing here says
 * planned or unplanned.
 */
function Observed(props: { readonly node: ExecutionNode }): ReactElement {
  const { observed } = props.node;
  const money = (minor: number | null): string =>
    minor === null ? 'not recorded' : `${String(minor)} ${observed.currency} (minor units)`;
  return (
    <div className="sbact" data-observed={observed.condition}>
      <div className="sbact__row">
        <span className="sb__state">{observedWords(props.node)}</span>
      </div>
      {observed.fault === null ? null : (
        <div className="sbact__row" data-observed-fault="">
          <span className="sbact__meta">Dropped: {observed.fault}</span>
        </div>
      )}
      {observed.lease?.state === 'lapsed' ? (
        <div className="sbact__row" data-observed-lease="lapsed">
          <span className="sbact__meta">
            Its lease ran out at {observed.lease.expiresAt} and no drop is recorded yet.
          </span>
        </div>
      ) : null}
      <div className="sbact__row">
        <span className="sbact__meta">
          Held {money(observed.heldMinor)}; spent {money(observed.spentMinor)}.{' '}
          {observed.effectObserved ? 'Its effect was observed.' : 'No effect observed yet.'}
        </span>
      </div>
    </div>
  );
}

function observedWords(node: ExecutionNode): string {
  const { observed } = node;
  switch (observed.condition) {
    case 'not_started':
      return 'Not started';
    case 'in_progress':
      return observed.whoseMove === null
        ? 'In progress'
        : `In progress: the ${observed.whoseMove.kind === 'agent' ? "agent's" : "person's"} move`;
    case 'settled':
      return `Settled: ${observed.outcome ?? 'unknown'}`;
    case 'superseded':
      return 'Superseded by a later version';
    default:
      return observed.runState;
  }
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

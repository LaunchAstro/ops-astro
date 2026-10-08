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
import { Banner, drawRunState, Empty, major, Spill } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  ExecutionRun,
  ExecutionEvent,
  ExecutionNode,
  ProposalView,
  ReceiptResult,
  TaskExecutionResult,
} from '../../../../packages/core-wire/src/index.ts';
import { RunMap } from './run-map.tsx';
import {
  isReadable,
  useTaskExecution,
  type TaskExecutionOptions,
  type TaskExecutionRead,
} from './task-execution.ts';
export {
  wholeExecution,
  isReadable,
  useTaskExecution,
  type TaskExecutionRead,
} from './task-execution.ts';
import { Observed } from './run-observed.tsx';
import { useRead } from '../data/use-read.ts';

export interface RunProgressProps extends TaskExecutionOptions {
  /** The task read's proposals, for each run's gate on the execution map (MP-6-3). */
  readonly proposals?: readonly ProposalView[];
}
/**
 * The run of one task read under one grant. A section is keyed by both, so
 * another grant or task (business, person or client) is a new section whose
 * read starts afresh: nothing the last one read or held (its graph, runs or
 * receipts) is drawn under the new scope, even when React batches the old
 * scope's answer into the same render as the change (SEC35 M1).
 */
export function RunProgress(props: RunProgressProps): ReactElement {
  return <RunSection key={JSON.stringify([props.grantKey, props.taskKey])} {...props} />;
}

function RunSection(props: RunProgressProps): ReactElement {
  const state = useTaskExecution(props);
  return <RunProgressRead {...props} state={state} />;
}

export function RunProgressRead(
  props: RunProgressProps & {
    readonly state: TaskExecutionRead;
  },
): ReactElement {
  const { client, taskKey, state } = props;
  const value =
    state.outcome === 'ready' || state.outcome === 'empty' ? (state.value.execution ?? null) : null;
  const settledRead = state.outcome === 'ready' || state.outcome === 'empty';
  const readable = value !== null && isReadable(value);
  const outcome = settledRead ? (readable ? value.outcome : 'unavailable') : state.outcome;
  const graph = readable ? value.graph : undefined;
  return (
    <>
      <RunMap
        graph={graph}
        proposals={props.proposals ?? []}
        read={state}
        scope={`${props.grantKey} ${taskKey}`}
      />
      <section className="sb__sect" data-outcome={outcome} data-run-progress="">
        <div className="sb__sh">
          <span className="sb__k">The run</span>
        </div>
        {state.outcome === 'loading' ? (
          <Empty look="inline" title="Reading the run…" />
        ) : state.outcome === 'denied' ? (
          <p className="card__sub" data-run="denied">
            The server refused this read ({state.refusal.code}), so nothing about the run is shown.
          </p>
        ) : state.outcome === 'unavailable' || !readable ? (
          // DS-PRIM-30: a read that could not be read is a section error, the bad banner.
          <div data-run="unavailable">
            <Banner tone="bad" lead="The run could not be read.">
              {state.outcome === 'unavailable' ? `${state.because} ` : ''}That is not a claim that
              no work ran.
            </Banner>
          </div>
        ) : value === null ? null : value.outcome === 'no-run' ? (
          <Empty title="No run yet" description="Nothing has been picked up on this task." />
        ) : (
          <Runs client={client} grantKey={props.grantKey} readOf={props.readOf} value={value} />
        )}
      </section>
    </>
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
          currency={props.node?.observed.currency ?? null}
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
 * control. The server answers `NOT_FOUND` alike for an attempt with no
 * observed effect and for one this reader may not see, so a refused read says
 * only that the receipt could not be read, never that nothing happened.
 */
function AttemptReceipt(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly readOf: unknown;
  readonly attemptId: string;
  /** The run's currency, from its observed node; null when the graph names none. */
  readonly currency: string | null;
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
      <div data-receipt="unavailable" data-receipt-attempt={attemptId}>
        <Banner tone="bad" lead={`The receipt for attempt ${attemptId} could not be read.`}>
          That is not a claim that no effect happened.
        </Banner>
      </div>
    );
  }
  return (
    <ReceiptBox attemptId={attemptId} receipt={state.value.receipt} currency={props.currency} />
  );
}

/** DS-TASK-6, the live body: the mockup's evidence box, one row per fact. */
function ReceiptBox(props: {
  readonly attemptId: string;
  readonly receipt: ReceiptResult['receipt'];
  /** The run's currency, from its observed node; null when the graph names none. */
  readonly currency: string | null;
}): ReactElement {
  const { attemptId, receipt } = props;
  const { settlement } = receipt;
  const amount = (minor: number): string =>
    props.currency === null ? `${String(minor)} minor units` : major(minor, props.currency);
  return (
    <section
      className="sb__sect sout"
      data-receipt-attempt={attemptId}
      data-receipt-decision={receipt.decision.id}
    >
      <div className="sb__sh">
        <span className="sb__k">Receipt</span>
        <span className="sb__meta">attempt {attemptId}</span>
      </div>
      <div className="sout__box">
        <div className="sout__row">
          <span className="tf__k">Approved</span>
          <span className="sout__v">
            by decision {receipt.decision.id} on version {receipt.version.number}
          </span>
        </div>
        <div className="sout__row">
          <span className="tf__k">Effect</span>
          <span className="sout__t">
            {receipt.effect.audience === 'internal' ? 'A team-only comment' : receipt.effect.kind}
          </span>
        </div>
        <div className="sout__row">
          <span className="tf__k">Money</span>
          <span className="sout__v" data-money={settlement.state}>
            {'spentMinor' in settlement
              ? `held ${amount(settlement.heldMinor)} · spent ${amount(settlement.spentMinor)} · released ${amount(settlement.releasedMinor)}`
              : `held ${amount(settlement.heldMinor)} · ${settlement.state.replaceAll('_', ' ')}`}
          </span>
        </div>
      </div>
    </section>
  );
}

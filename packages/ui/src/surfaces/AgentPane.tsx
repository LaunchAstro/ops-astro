// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane (MP-6-1, mockup S3 DA-01 to DA-07, TA-03): the run on a task,
// its workflow, what it staged, and the gate on the exact version.
//
// Every word comes from `runStories` (`state/agent-run.ts`), so the summary,
// the workflow, the gate box and the lifecycle word tell one story. The pane
// decides nothing itself: the gate box's two controls, the header's "Reject
// this proposal" and Cancel hand the exact gate and version the read showed to
// the caller, which sends them through the real decide path. The mockup's
// demonstration state is not ported (R44). Its parts live in `agent/`.

import { useState, type ReactElement } from 'react';
import { runStories, type RunStory } from '../state/agent-run.ts';
import type { RunLineage } from '../state/run-projection.ts';
import { Attempts } from './agent/attempts.tsx';
import { Gate, type GateDecision, type GateRef } from './agent/gate.tsx';
import { RunKnowledge } from './agent/knowledge.tsx';
import { ProposalHeader, Summary, Workflow } from './agent/header.tsx';
import { Given } from './agent/given.tsx';
import { Scope } from './agent/scope.tsx';
import { StagedOutput } from './agent/staged.tsx';
import { scopeStamp } from '../state/agent-scope.ts';
import { latestStops, type TaskLedger } from '../state/token-ledger.ts';
import { StopAnswer } from './agent/stops.tsx';
import { TokenTracked } from './agent/tokens.tsx';
import { UnknownOutcome, type RecordedOutcome } from './agent/unknown.tsx';

export type { GateDecision } from './agent/gate.tsx';
export type { RecordedOutcome } from './agent/unknown.tsx';

export interface AgentPaneProps {
  /** `task.read`'s proposals; absent on a read that carries none. */
  readonly lineages: readonly RunLineage[] | undefined;
  /** What approving the gate will do, in the server's words; null when it has not said. */
  readonly effect: string | null;
  /** A person's name for an id the decision chain carries. */
  readonly nameOf: (personId: string) => string;
  /** Whether the job list starts open: the person's own saved preference (CS-6.2). */
  readonly jobListOpen: boolean;
  readonly onJobList: (open: boolean) => void;
  readonly busy: boolean;
  /** The server's refusal of the last action, quoted as it came. */
  readonly refusal: string | null;
  readonly onDecide: (gate: GateRef, decision: GateDecision) => void;
  readonly onReject: (gate: GateRef) => void;
  readonly onCancel: (lineageId: string) => void;
  /** The access ledger's address for one grant, or null while the ledger has no screen. */
  readonly ledgerHref: ((grantId: string) => string) | null;
  /** `task.read`'s token ledger (MP-6-5); null for a reader it is not shown to. */
  readonly ledger: TaskLedger | null;
  /**
   * A person's word on an unknown effect (C54): one of the three outcomes, or
   * a write-off at an amount with a reason. Absent where the host offers
   * neither, and then no control is drawn.
   */
  readonly onOutcome?: (attemptId: string, outcome: RecordedOutcome) => void;
  readonly onWriteOff?: (attemptId: string, amountMinor: number, reason: string) => void;
  /** The server's word that a write-off waits on a second person, or null. */
  readonly writeOffAwaiting?: string | null;
  /** C54's answers at a budget stop (AW-05), where the host offers both. */
  readonly onTopUpAtStop?: (runId: string, amountMinor: number, currency: string) => void;
  readonly onEndAtStop?: (runId: string) => void;
  /** The server's word that the last top-up at a stop waits on a second person, or null. */
  readonly stopAwaiting?: string | null;
}

export function AgentPane(props: AgentPaneProps): ReactElement {
  const stories = runStories(props.lineages);
  const current = stories.at(-1);
  const [opened, setOpened] = useState<string | null>(null);
  if (current === undefined) {
    return (
      <section className="agent" data-agent="invitation">
        <p className="sb__say">
          Nothing has been handed to the agent on this task yet. Write a brief to tell it what to
          do, and it proposes a run for a person to approve before anything happens.
        </p>
      </section>
    );
  }
  const shown = stories.find((story) => story.lineageId === opened) ?? current;
  return (
    <section className="agent" data-agent="pane" data-agent-lineage={shown.lineageId}>
      <RunView {...props} shown={shown} />
      <Attempts stories={stories} shown={shown} onOpen={setOpened} />
    </section>
  );
}

function RunView(props: AgentPaneProps & { readonly shown: RunStory }): ReactElement {
  const { shown } = props;
  const lineage = (props.lineages ?? []).find((each) => each.lineageId === shown.lineageId);
  // The mockup's S6 layout: the run in main, what it was given in a side column after it.
  return (
    <div className="tpg">
      <div className="tpg__main" data-agent="main">
        <ProposalHeader
          story={shown}
          busy={props.busy}
          onReject={props.onReject}
          onCancel={props.onCancel}
        />
        {props.refusal === null ? null : (
          <p className="field__error" role="alert" data-agent="refusal">
            {props.refusal}
          </p>
        )}
        <div className="sb__sh">
          <span className="sb__k">Current run</span>
          <span className="sbact__meta u-mono" data-agent="run-id">
            {shown.head.runId ?? 'not planned'}
          </span>
        </div>
        <Summary story={shown} />
        <RunKnowledge runId={shown.head.runId} states={props.ledger?.states} />
        <Unknown {...props} shown={shown} />
        <StopAnswers {...props} />
        <Workflow jobs={shown.jobs} open={props.jobListOpen} onToggle={props.onJobList} />
        <StagedOutput story={shown} />
        <Gate
          story={shown}
          effect={props.effect}
          busy={props.busy}
          nameOf={props.nameOf}
          decisions={lineage?.decisions ?? []}
          onDecide={props.onDecide}
        />
      </div>
      <RunSide {...props} shown={shown} />
    </div>
  );
}

/** The side column: the scope the run was granted, what it was given and the task's allowance. */
function RunSide(props: AgentPaneProps & { readonly shown: RunStory }): ReactElement {
  const lineage = (props.lineages ?? []).find((each) => each.lineageId === props.shown.lineageId);
  return (
    <aside className="tpg__side" data-agent="side" aria-label="Scope and allowance">
      <Scope
        stamp={scopeStamp(lineage)}
        head={props.shown.head}
        nameOf={props.nameOf}
        ledgerHref={props.ledgerHref}
      />
      <Given head={props.shown.head} />
      <TokenTracked ledger={props.ledger} lineages={props.lineages ?? []} />
    </aside>
  );
}

/** C54's controls on the shown run, where the host offers both acts. */
function Unknown(props: AgentPaneProps & { readonly shown: RunStory }): ReactElement | null {
  if (props.onOutcome === undefined || props.onWriteOff === undefined) return null;
  return (
    <UnknownOutcome
      key={props.shown.unknownAttempt?.id ?? 'none'}
      story={props.shown}
      busy={props.busy}
      awaiting={props.writeOffAwaiting ?? null}
      onOutcome={props.onOutcome}
      onWriteOff={props.onWriteOff}
    />
  );
}

/** C54's answers at each run's waiting stop, where the host offers both. */
function StopAnswers(props: AgentPaneProps): ReactElement | null {
  const { onTopUpAtStop, onEndAtStop } = props;
  if (onTopUpAtStop === undefined || onEndAtStop === undefined) return null;
  const waiting = latestStops(props.ledger).filter((stop) => stop.answer === null);
  return (
    <>
      {waiting.map((stop) => (
        <StopAnswer
          key={stop.askId}
          stop={stop}
          busy={props.busy}
          awaiting={props.stopAwaiting ?? null}
          onTopUp={onTopUpAtStop}
          onEnd={onEndAtStop}
        />
      ))}
    </>
  );
}

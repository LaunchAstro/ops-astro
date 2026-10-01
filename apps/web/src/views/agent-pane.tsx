// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane on the task page (MP-6-1), wired to the real commands.
//
// `AgentPane` draws what `task.read` stored and returned; this view hands its
// controls to the same paths the rest of the page uses. A decision names the
// gate and the version the pane drew, from the same read that showed the
// evidence, and the server compares that version under its locks: a page that
// has gone stale is told so and reads again, never decides by accident.
// Reject is the decide path's `reject`, pressed from the proposal header.
// Cancel is `task.cancel`, which asks `gate:decide`. A person's word on an
// unknown effect (C54) is `budget.record_outcome` (T3d1) or `budget.write_off`
// (T3c), naming the attempt the read showed; both ask `billing:decide`, and the
// write-off's second approver above the band is the server's. The top-up is
// the task page's own (T2e). A run stopped at its ceiling (AW-05) is answered
// with `run.top_up` (`billing:decide`) or `run.end_at_budget_stop`
// (`gate:decide`), naming the task and the run the read showed. Every outcome
// ends in a reread, as the proposals section's does. The operational log
// (MP-6-2) is `task.execution`'s events and bound plan, read again with each
// new task read, as the run's own section reads them; a refused or failed read
// draws no log, and the run's section says why.

import { useState, type ReactElement } from 'react';
import {
  AgentPane,
  type GateDecision,
  type RecordedOutcome,
  type RunActivity,
} from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  PersonView,
  ProposalView,
  TaskExecutionResult,
  TaskLedgerView,
} from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import { useCommand, type Settlement } from '../records/use-command.ts';
import { wholeExecution } from './run-progress.tsx';

export interface AgentSectionProps {
  readonly client: OperationsClient;
  readonly recordId: string;
  /** The task's key and the page's grant, for the operational log's read (MP-6-2). */
  readonly taskKey: string;
  readonly grantKey: string;
  /** The task read's latest answer: each new one re-reads the log. */
  readonly readOf: unknown;
  readonly proposals: readonly ProposalView[];
  readonly people: readonly PersonView[];
  /** `task.read`'s token ledger (MP-6-5): null for a reader it is not shown to, absent on an older read. */
  readonly ledger: TaskLedgerView | null | undefined;
  readonly onChanged: () => void;
}

interface AgentControls {
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly decide: (
    gate: { readonly gateId: string; readonly versionId: string },
    decision: GateDecision | 'reject',
  ) => void;
  readonly cancel: (lineageId: string) => void;
  readonly recordOutcome: (attemptId: string, outcome: RecordedOutcome) => void;
  readonly writeOff: (attemptId: string, amountMinor: number, reason: string) => void;
  /** The server's word that the last write-off waits on a second person, or null. */
  readonly awaiting: string | null;
  readonly topUpAtStop: (runId: string, amountMinor: number, currency: string) => void;
  readonly endAtStop: (runId: string) => void;
  /** The server's word that the last top-up at a stop waits on a second person, or null. */
  readonly stopAwaiting: string | null;
}

/** The `detail.state` a command's answer carries, if any. */
const stateOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? (value as { readonly detail?: Readonly<Record<string, unknown>> }).detail?.['state']
    : undefined;

const AWAITING =
  'Your write-off is recorded. Above the four-eyes threshold a second person approves it too.';
const STOP_AWAITING =
  'Your top-up is recorded. Above the four-eyes threshold it applies when a second person approves the same amount.';

/** The pane's controls on the real commands, each ending in a reread. */
function useAgentControls(props: AgentSectionProps): AgentControls {
  const { busy, run } = useCommand();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [stopAwaiting, setStopAwaiting] = useState<string | null>(null);
  const settle = (settlement: Settlement): void => {
    setRefusal(settlement.kind === 'ok' ? null : settlement.because);
    const state = settlement.kind === 'ok' ? stateOf(settlement.value) : undefined;
    setAwaiting(state === 'awaiting_second_approver' ? AWAITING : null);
    setStopAwaiting(state === 'awaiting_second' ? STOP_AWAITING : null);
    props.onChanged();
  };
  const decide: AgentControls['decide'] = (gate, decision) => {
    if (busy) return;
    run(
      () =>
        props.client.mutate('task.decide', {
          gateId: gate.gateId,
          versionId: gate.versionId,
          decision,
          note: `Decided from the Agent pane (${decision}).`,
        }),
      settle,
    );
  };
  const cancel = (lineageId: string): void => {
    if (busy) return;
    run(
      () =>
        props.client.mutate('task.cancel', {
          recordId: props.recordId,
          lineageId,
          reason: 'Cancelled from the Agent pane.',
        }),
      settle,
    );
  };
  const send = (call: () => ReturnType<OperationsClient['mutate']>): void => {
    run(call, settle);
  };
  const acts = { ...unknownControls(props, busy, send), ...stopControls(props, busy, send) };
  return { busy, refusal, decide, cancel, awaiting, stopAwaiting, ...acts };
}

/** C54's two answers at a budget stop, each on its owning command (AW-05). */
function stopControls(
  props: AgentSectionProps,
  busy: boolean,
  send: (call: () => ReturnType<OperationsClient['mutate']>) => void,
): Pick<AgentControls, 'topUpAtStop' | 'endAtStop'> {
  return {
    topUpAtStop: (runId, amountMinor, currency) => {
      if (busy) return;
      send(() =>
        props.client.mutate('run.top_up', {
          recordId: props.recordId,
          runId,
          amountMinor,
          currency,
        }),
      );
    },
    endAtStop: (runId) => {
      if (busy) return;
      send(() =>
        props.client.mutate('run.end_at_budget_stop', { recordId: props.recordId, runId }),
      );
    },
  };
}

/** C54's two acts on an unknown effect, each on its owning command (T3d1, T3c). */
function unknownControls(
  props: AgentSectionProps,
  busy: boolean,
  send: (call: () => ReturnType<OperationsClient['mutate']>) => void,
): Pick<AgentControls, 'recordOutcome' | 'writeOff'> {
  return {
    recordOutcome: (attemptId, outcome) => {
      if (busy) return;
      send(() =>
        props.client.mutate('budget.record_outcome', {
          recordId: props.recordId,
          attemptId,
          outcome,
        }),
      );
    },
    writeOff: (attemptId, amountMinor, reason) => {
      if (busy) return;
      send(() =>
        props.client.mutate('budget.write_off', {
          recordId: props.recordId,
          attemptId,
          amountMinor,
          reason,
        }),
      );
    },
  };
}

export function AgentSection(props: AgentSectionProps): ReactElement {
  const controls = useAgentControls(props);
  const { busy, refusal, decide, cancel, recordOutcome, writeOff, awaiting } = controls;
  // The person's own choice for this view. It is saved through the one
  // preference store once that store is in (MP-2-11); until then it lasts
  // as long as the page.
  const [jobListOpen, setJobListOpen] = useState(false);
  const activity = useActivity(props);
  const nameOf = (personId: string): string =>
    props.people.find((person) => person.personId === personId)?.name ?? 'a person';

  return (
    <section className="sb__sect" data-section="agent" aria-label="Agent">
      <AgentPane
        lineages={props.proposals}
        effect={null}
        nameOf={nameOf}
        jobListOpen={jobListOpen}
        onJobList={setJobListOpen}
        busy={busy}
        refusal={refusal}
        onDecide={decide}
        onReject={(gate) => {
          decide(gate, 'reject');
        }}
        onCancel={cancel}
        // The access ledger has no screen yet, so the stamp names each grant it
        // draws on without a link; the ledger's route supplies one when it lands.
        ledgerHref={null}
        ledger={props.ledger ?? null}
        onOutcome={recordOutcome}
        onWriteOff={writeOff}
        writeOffAwaiting={awaiting}
        onTopUpAtStop={controls.topUpAtStop}
        onEndAtStop={controls.endAtStop}
        stopAwaiting={controls.stopAwaiting}
        {...(activity === undefined ? {} : { activity })}
      />
    </section>
  );
}

/** The log's rows: the execution read's events and its bound plan's steps, once read. */
function useActivity(props: AgentSectionProps): RunActivity | undefined {
  const { state } = useRead<TaskExecutionResult>({
    grantKey: props.grantKey,
    run: async () => await wholeExecution(props.client, props.taskKey),
    deps: [props.taskKey, props.readOf],
  });
  if (state.outcome !== 'ready' && state.outcome !== 'empty') return undefined;
  const execution = state.value.execution as Partial<TaskExecutionResult['execution']> | undefined;
  if (!Array.isArray(execution?.events)) return undefined;
  return { steps: execution.graph?.steps ?? [], events: execution.events };
}

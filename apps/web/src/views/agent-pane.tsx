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
// (`gate:decide`), naming the task, the run and the stop the read showed.
// Every outcome ends in a reread, as the proposals section's does.

import { useState, type ReactElement } from 'react';
import { AgentPane, type GateDecision, type RecordedOutcome } from '@launchastro/ui';
import { askDrawer, newAttemptAsk } from '../assistant/asks.ts';
import type { OperationsClient } from '../operations/client.ts';
import type {
  PersonView,
  ProposalView,
  TaskLedgerView,
} from '../../../../packages/core-wire/src/index.ts';
import type { Settlement } from '../records/use-command.ts';
import { useMoneyCommand, type StepUpAsk } from '../records/use-money-command.ts';
import { StepUpPrompt } from './step-up-prompt.tsx';

export interface AgentSectionProps {
  readonly client: OperationsClient;
  /** The session the page is read under: the drawer's ask carries it. */
  readonly grantKey: string;
  readonly recordId: string;
  /** The task's title as the read gave it, or its key while it has none: the drawer's ask names it. */
  readonly title: string;
  /**
   * The client the task is under, as `task.read` sent it: null on an internal
   * task, and on one whose client the reader's grants do not reach (CS-4.12).
   * The drawer's ask carries it, so the egress rule sees whose data a plan
   * would carry (AW-04).
   */
  readonly clientId: string | null;
  /** The task is under a client the reader cannot see (`clientSet`, no id): its setting reads as off. */
  readonly clientUnseen: boolean;
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
  readonly topUpAtStop: (
    runId: string,
    askId: string,
    amountMinor: number,
    currency: string,
  ) => void;
  readonly endAtStop: (runId: string, askId: string) => void;
  /** The server's word that the last top-up at a stop waits on a second person, or null. */
  readonly stopAwaiting: string | null;
  /** The money step-up prompt, while a refused money write waits on a code. */
  readonly stepUp: StepUpAsk | null;
}

/** One write, handed the client of the sign-in it goes on. */
type Call = (client: OperationsClient) => ReturnType<OperationsClient['mutate']>;

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
  const { busy, run, stepUp } = useMoneyCommand(props.client);
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
      (client) =>
        client.mutate('task.decide', {
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
      (client) =>
        client.mutate('task.cancel', {
          recordId: props.recordId,
          lineageId,
          reason: 'Cancelled from the Agent pane.',
        }),
      settle,
    );
  };
  const send = (call: Call): void => {
    run(call, settle);
  };
  const acts = { ...unknownControls(props, busy, send), ...stopControls(props, busy, send) };
  return { busy, refusal, decide, cancel, awaiting, stopAwaiting, stepUp, ...acts };
}

/** C54's two answers at a budget stop, each on its owning command (AW-05). */
function stopControls(
  props: AgentSectionProps,
  busy: boolean,
  send: (call: Call) => void,
): Pick<AgentControls, 'topUpAtStop' | 'endAtStop'> {
  return {
    topUpAtStop: (runId, askId, amountMinor, currency) => {
      if (busy) return;
      send((client) =>
        client.mutate('run.top_up', {
          recordId: props.recordId,
          runId,
          askId,
          amountMinor,
          currency,
        }),
      );
    },
    endAtStop: (runId, askId) => {
      if (busy) return;
      send((client) =>
        client.mutate('run.end_at_budget_stop', { recordId: props.recordId, runId, askId }),
      );
    },
  };
}

/** C54's two acts on an unknown effect, each on its owning command (T3d1, T3c). */
function unknownControls(
  props: AgentSectionProps,
  busy: boolean,
  send: (call: Call) => void,
): Pick<AgentControls, 'recordOutcome' | 'writeOff'> {
  return {
    recordOutcome: (attemptId, outcome) => {
      if (busy) return;
      send((client) =>
        client.mutate('budget.record_outcome', {
          recordId: props.recordId,
          attemptId,
          outcome,
        }),
      );
    },
    writeOff: (attemptId, amountMinor, reason) => {
      if (busy) return;
      send((client) =>
        client.mutate('budget.write_off', {
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
        onStartAttempt={() => {
          const { recordId: id, title, clientId } = props;
          const unseen = props.clientUnseen ? { clientUnseen: true as const } : {};
          askDrawer(newAttemptAsk({ id, title, clientId, ...unseen }), props.grantKey);
        }}
      />
      {controls.stepUp === null ? null : <StepUpPrompt ask={controls.stepUp} />}
    </section>
  );
}

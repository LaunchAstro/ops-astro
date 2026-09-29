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
// Cancel is `task.cancel`, which asks `gate:decide`. Every outcome ends in a
// reread, as the proposals section's does.

import { useState, type ReactElement } from 'react';
import { AgentPane, type GateDecision } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  PersonView,
  ProposalView,
  TaskLedgerView,
} from '../../../../packages/core-wire/src/index.ts';
import { useCommand, type Settlement } from '../records/use-command.ts';

export interface AgentSectionProps {
  readonly client: OperationsClient;
  readonly recordId: string;
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
}

/** The pane's controls on the real commands, each ending in a reread. */
function useAgentControls(props: AgentSectionProps): AgentControls {
  const { busy, run } = useCommand();
  const [refusal, setRefusal] = useState<string | null>(null);
  const settle = (settlement: Settlement): void => {
    setRefusal(settlement.kind === 'ok' ? null : settlement.because);
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
  return { busy, refusal, decide, cancel };
}

export function AgentSection(props: AgentSectionProps): ReactElement {
  const { busy, refusal, decide, cancel } = useAgentControls(props);
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
      />
    </section>
  );
}

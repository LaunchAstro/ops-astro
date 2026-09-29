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
import { ProposalHeader, Summary, Workflow } from './agent/header.tsx';
import { Activity, Artefacts, Given, Hero } from './agent/page.tsx';
import { Scope } from './agent/scope.tsx';
import { StagedOutput } from './agent/staged.tsx';
import { activityOf, artefactsOf, heroCells } from '../state/agent-page.ts';
import { scopeStamp } from '../state/agent-scope.ts';

export type { GateDecision } from './agent/gate.tsx';

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
  /** The clock the hero's elapsed time reads, in milliseconds; the browser's when absent. */
  readonly now?: number;
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
  const lineage = (props.lineages ?? []).find((each) => each.lineageId === shown.lineageId);
  // The page's two columns (MP-6-2): the run in the main column, what it was
  // allowed and given in a side column that is 21rem wide at 1279px and up.
  return (
    <section className="agent" data-agent="pane" data-agent-lineage={shown.lineageId}>
      <div className="agentpage">
        <div className="agentpage__main">
          <RunView {...props} shown={shown} lineage={lineage} />
          <Attempts stories={stories} shown={shown} onOpen={setOpened} />
        </div>
        <aside className="agentpage__side" data-agent="side">
          <Scope
            stamp={scopeStamp(lineage)}
            head={shown.head}
            nameOf={props.nameOf}
            ledgerHref={props.ledgerHref}
          />
          <Given />
        </aside>
      </div>
    </section>
  );
}

function RunView(
  props: AgentPaneProps & { readonly shown: RunStory; readonly lineage: RunLineage | undefined },
): ReactElement {
  const { shown, lineage } = props;
  return (
    <>
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
      <Hero story={shown} cells={heroCells(shown, lineage, props.now ?? Date.now())} />
      <Summary story={shown} />
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
      <Artefacts artefacts={artefactsOf(lineage)} />
      <Activity rows={activityOf(lineage, props.nameOf)} />
    </>
  );
}

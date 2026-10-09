// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { PersonListResult } from '../../../../../packages/core-wire/src/index.ts';
import type { LoadedProps } from './loaded-props.ts';
import { AgentSection } from '../../views/agent-pane.tsx';
import { Proposals } from '../../views/proposals.tsx';
import { RunProgressRead } from '../../views/run-progress.tsx';
import type { TaskExecutionRead } from '../../views/task-execution.ts';
import { Alerts } from './Alerts.tsx';
import { BriefSection } from './Writing.tsx';

interface TaskAgentSideProps {
  readonly props: LoadedProps;
  readonly execution: TaskExecutionRead;
  readonly persons: PersonListResult['persons'];
  readonly outages: ReactElement;
}

/** The agent section (MP-6-1): the run's pane, full width above the Agent side's columns. */
function AgentHead({
  props,
  execution,
  persons,
}: Pick<TaskAgentSideProps, 'props' | 'execution' | 'persons'>): ReactElement {
  const { client, task } = props;
  return (
    <AgentSection
      client={client}
      execution={execution}
      grantKey={props.grantKey}
      recordId={task.id}
      title={task.title === null || task.title === '' ? task.key : task.title}
      clientId={task.client}
      clientUnseen={task.clientSet && task.client === null}
      taskKey={task.key}
      readOf={props.taskRead}
      proposals={task.proposals}
      people={persons}
      ledger={task.ledger}
      onChanged={props.onChanged}
      note={props.note}
      onDecided={props.onDecided}
      onStepUp={props.onStepUp}
    />
  );
}

/**
 * The Agent side of the task (MP-4-3): the brief (MP-4-7), the proposals and
 * their gates with the top-up (T2e), and the run as it goes (T2a progress,
 * T2h alerts, T3e2 outages). DS-TASK-15 lays it out: the brief, the run and
 * its gate in the main column, the standing facts about the task's run (its
 * alerts, the team's outages) beside. The agent section (MP-6-1) sits above
 * them, full width, as batch 3a drew it.
 */
export function AgentSide({
  props,
  execution,
  persons,
  outages,
}: TaskAgentSideProps): ReactElement {
  const { client, task } = props;
  return (
    <div className="stack">
      <AgentHead props={props} execution={execution} persons={persons} />
      <div className="tpg">
        <div className="tpg__main">
          <BriefSection brief={task.agentBrief} />
          <RunProgressRead
            state={execution}
            client={client}
            grantKey={props.grantKey}
            proposals={task.proposals}
            readOf={props.taskRead}
            taskKey={task.key}
          />
          <Proposals
            capCurrency={task.capCurrency}
            client={client}
            note={props.note}
            onChanged={props.onChanged}
            onDecided={props.onDecided}
            onProposeRefused={props.onProposeRefused}
            proposeRefusal={props.proposeRefusal}
            proposeDraft={props.proposeDraft}
            onProposeDraft={props.onProposeDraft}
            persons={persons}
            proposals={task.proposals}
            envelope={task.envelope ?? null}
            topUpNote={props.topUpNote}
            onTopUpNote={props.onTopUpNote}
            recordId={task.id}
            revision={task.revision}
          />
        </div>
        <aside className="tpg__side">
          <Alerts alerts={task.alerts} />
          {outages}
        </aside>
      </div>
    </div>
  );
}

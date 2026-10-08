// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the task page and the dock task panel: the task's agent
// when it is the reader's own (the server sends no other), and a select of the reader's own agents
// that reach the task (`myAgents`, which the server fills with nothing
// else). Choosing one sends `task.assign` with `agent` at the read revision;
// a landed write asks for a reread. With none of the reader's own agents, no
// control is drawn, so nothing hints that anyone else's exists. The page locks
// it as it locks the assignee: while a write is in flight or an edit unsaved.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { useTaskAssignment } from './assignment-context.tsx';
import { AssignmentRecovery } from './AssignmentRecovery.tsx';

export interface AssignToAIProps {
  readonly client: OperationsClient;
  readonly task: Task;
  /** The id prefix: `panel` in the dock, `page` on the task page. */
  readonly scope: 'panel' | 'page';
  readonly onChanged: () => void;
  /** The page's lock: a write in flight or an unsaved edit. */
  readonly disabled?: boolean;
  readonly grantKey?: string;
  readonly recovery?: boolean;
}

export function AssignToAI(props: AssignToAIProps): ReactElement | null {
  const { task } = props;
  const assignment = useTaskAssignment(props.client, props.grantKey, task.id, props.onChanged);
  const assign = (agent: string): void => {
    void assignment.custody.choose(task.id, task.revision, { agent });
  };
  const recovery =
    props.recovery === false ? null : (
      <AssignmentRecovery custody={assignment.custody} hold={assignment.hold} recordId={task.id} />
    );
  const held = task.agent;
  if (held === null && task.myAgents.length === 0) return recovery;
  const id = `${props.scope}-assign-ai`;
  return (
    <div className="field" data-assign-ai>
      {held === null ? null : (
        <p className="card__sub" data-agent-assignee>
          Assigned to AI: {held.purpose}, for {held.accountable.name}
        </p>
      )}
      {task.myAgents.length === 0 ? null : (
        <AgentSelect
          id={id}
          task={task}
          busy={assignment.locked || props.disabled === true}
          onAssign={assign}
        />
      )}
      {recovery}
    </div>
  );
}

/** The reader's own agents for the task; the held one selected when it is theirs. */
function AgentSelect(props: {
  readonly id: string;
  readonly task: Task;
  readonly busy: boolean;
  readonly onAssign: (agent: string) => void;
}): ReactElement {
  const { task } = props;
  const held = task.agent?.delegationId ?? '';
  const mine = task.myAgents.some((one) => one.delegationId === held);
  return (
    <>
      <label className="tf__k" htmlFor={props.id}>
        Assign to AI
      </label>
      <select
        id={props.id}
        className="input"
        disabled={props.busy}
        value={mine ? held : ''}
        onChange={(event) => {
          if (event.target.value !== '') props.onAssign(event.target.value);
        }}
      >
        <option value="">Choose one of your agents</option>
        {task.myAgents.map((agent) => (
          <option key={agent.delegationId} value={agent.delegationId}>
            {agent.purpose}
          </option>
        ))}
      </select>
    </>
  );
}

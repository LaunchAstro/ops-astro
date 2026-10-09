// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type {
  InternalTaskDetail as Task,
  PersonListResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import type { UseReadResult } from '../../data/use-read.ts';
import { Assignee } from './Lifecycle.tsx';
import { AssignToAI } from './AssignToAI.tsx';
import { AssignmentRecovery } from './AssignmentRecovery.tsx';
import { useTaskAssignment } from './assignment-context.tsx';

interface PageAssignmentProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly grantKey: string;
  readonly people: UseReadResult<PersonListResult>;
  readonly disabled: boolean;
  readonly onChanged: () => void;
}

/** The page's person/own-agent choices share one held task.assign attempt. */
export function PageAssignment(props: PageAssignmentProps): ReactElement {
  const { client, task } = props;
  const assignment = useTaskAssignment(client, props.grantKey, task.id, props.onChanged);
  const locked = props.disabled;
  return (
    <>
      <Assignee
        people={props.people.state}
        onRetry={props.people.reload}
        assignee={task.assignee}
        disabled={locked || assignment.locked}
        onAssign={(personId) => {
          void assignment.custody.choose(task.id, task.revision, {
            assignee: personId === '' ? null : personId,
          });
        }}
      />

      <AssignToAI
        client={client}
        task={task}
        scope="page"
        grantKey={props.grantKey}
        recovery={false}
        disabled={locked || assignment.locked}
        onChanged={props.onChanged}
      />
      <AssignmentRecovery custody={assignment.custody} hold={assignment.hold} recordId={task.id} />
    </>
  );
}

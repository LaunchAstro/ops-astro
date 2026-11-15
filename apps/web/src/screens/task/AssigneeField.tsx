// SPDX-License-Identifier: AGPL-3.0-only
import { Avatar, StyledSelect } from '@launchastro/ui';
import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type {
  InternalTaskDetail,
  PersonListResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import type { useTaskAssignment } from './assignment-context.tsx';
import { FormerAssignee } from './Lifecycle.tsx';

/** A person or nobody, from the people this business can be assigned work. */
export function AssigneeField(props: {
  readonly client: OperationsClient;
  readonly task: InternalTaskDetail;
  readonly grantKey: string;
  readonly busy: boolean;
  readonly assignment: ReturnType<typeof useTaskAssignment>;
}): ReactElement {
  const { client, task } = props;
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    deps: [],
  });
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-assignee">
        Assignee
      </label>
      <RecordState state={people.state} subject="people" onRetry={people.reload}>
        {(value) => (
          <StyledSelect
            id="panel-field-assignee"
            leading={task.assignee === null ? undefined : <Avatar name={task.assignee.name} />}
            optionLeading={(id) => {
              const person = value.persons.find((candidate) => candidate.personId === id);
              return person === undefined ? null : <Avatar name={person.name} />;
            }}
            className="input"
            disabled={props.busy || props.assignment.locked}
            value={task.assignee?.personId ?? ''}
            onChange={(event) =>
              void props.assignment.custody.choose(task.id, task.revision, {
                assignee: event.target.value === '' ? null : event.target.value,
              })
            }
          >
            <option value="">Unassigned</option>
            <FormerAssignee assignee={task.assignee} persons={value.persons} />
            {value.persons.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.name}
              </option>
            ))}
          </StyledSelect>
        )}
      </RecordState>
    </>
  );
}

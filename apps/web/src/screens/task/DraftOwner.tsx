// SPDX-License-Identifier: AGPL-3.0-only
//
// The draft's owner (U112): a person, an AI agent by name, or nobody. The
// people and the agents the reader may direct are read when the select is
// first focused, so Create never waits on them; a draft that already names an
// owner shows that name until they answer. Create writes the choice by
// `task.assign`, a person as `assignee` and an agent as `agent`. Choosing an
// agent records the assignment and starts no run: a person launches one.

import { useEffect, useState, type ReactElement } from 'react';
import type {
  PersonListResult,
  TaskBoardResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { TaskDraft } from './task-draft.ts';
import { Select, type Choice } from './DraftSelect.tsx';

type Owner = NonNullable<TaskDraft['owner']>;

const valueOf = (owner: Owner): string =>
  `${owner.agent === true ? 'agent' : 'person'}:${owner.id}`;
const labelOf = (owner: Owner): string => (owner.agent === true ? `AI: ${owner.name}` : owner.name);

/** The people, then the agents the reader may direct, read once `asked`; empty until they answer. */
function useOwners(client: OperationsClient, asked: boolean): readonly Owner[] {
  const [owners, setOwners] = useState<readonly Owner[]>([]);
  useEffect(() => {
    if (!asked) return;
    let live = true;
    void Promise.all([
      client.read<PersonListResult>('person.list', {}),
      client.read<TaskBoardResult>('task.board', { board: null }),
    ]).then(([people, board]) => {
      if (!live) return null;
      const persons = isRefusal(people) || isUnavailable(people) ? [] : people.value.persons;
      const agents = isRefusal(board) || isUnavailable(board) ? [] : (board.value.myAgents ?? []);
      setOwners([
        ...persons.map((person) => ({ id: person.personId, name: person.name })),
        ...agents.map((agent) => ({ id: agent.agentId, name: agent.name, agent: true as const })),
      ]);
      return null;
    });
    return () => {
      live = false;
    };
  }, [asked, client]);
  return owners;
}

export function DraftOwner(props: {
  readonly client: OperationsClient;
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  readonly locked: boolean;
}): ReactElement {
  const chosen = props.draft.owner;
  const [asked, setAsked] = useState(false);
  const owners = useOwners(props.client, asked);
  const offered =
    chosen === null || owners.some((owner) => valueOf(owner) === valueOf(chosen))
      ? owners
      : [chosen, ...owners];
  const choices: readonly Choice[] = offered.map((owner) => ({
    id: valueOf(owner),
    title: labelOf(owner),
  }));
  return (
    <Select
      id="panel-draft-owner"
      label="Owner"
      none="Unassigned"
      locked={props.locked}
      value={chosen === null ? null : valueOf(chosen)}
      choices={choices}
      onFocus={() => {
        setAsked(true);
      }}
      onChoose={(value) => {
        props.put({ owner: offered.find((owner) => valueOf(owner) === value) ?? null });
      }}
    />
  );
}

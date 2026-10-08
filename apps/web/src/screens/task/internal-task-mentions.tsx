// SPDX-License-Identifier: AGPL-3.0-only
import { Select } from '@launchastro/ui';
import type { PersonListResult } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead, type UseReadLive } from '../../data/use-read.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import { RecordState } from '../../views/record-state.tsx';

/** In-memory draft ownership, never a claim sent to the server. */
export interface InternalTaskMentionsOwner {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly grantKey?: string;
}
export const sameMentionsOwner = (
  left: InternalTaskMentionsOwner,
  right: InternalTaskMentionsOwner,
): boolean =>
  left.client === right.client &&
  left.recordId === right.recordId &&
  left.grantKey === right.grantKey;

/** Person-list authority supplies choices; recipient task-read authority remains server-owned. */
interface MentionsProps {
  readonly people: UseReadLive<PersonListResult>;
  readonly id: string;
  readonly selected: readonly string[];
  readonly locked: boolean;
  readonly clearLocked: boolean;
  readonly onChange: (ids: readonly string[]) => void;
}

export function useInternalTaskMentions(
  owner: InternalTaskMentionsOwner,
): UseReadLive<PersonListResult> {
  const { client, recordId, grantKey } = owner;
  return useRead<PersonListResult>({
    grantKey: grantKey ?? client.businessKey,
    deps: [client, recordId],
    run: () => client.read<PersonListResult>('person.list', {}),
    rollup: tabRollupFloor(),
    isEmpty: (value) => value.persons.length === 0,
  });
}

export function unavailableMentions(
  people: UseReadLive<PersonListResult>,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return false;
  const state = people.state;
  return (
    !people.own ||
    state.outcome !== 'ready' ||
    selected.some((id) => !state.value.persons.some((person) => person.personId === id))
  );
}

export function InternalTaskMentions(props: MentionsProps) {
  const people = props.people;
  if (!people.own) return null;
  return (
    <>
      {props.selected.length === 0 ? null : (
        <button
          className="btn btn--ghost"
          type="button"
          data-mention-clear
          disabled={props.clearLocked}
          onClick={() => props.onChange([])}
        >
          Clear mentions
        </button>
      )}
      <RecordState state={people.state} subject="people" onRetry={people.reload}>
        {(value) => (
          <div className="field" data-internal-task-mentions={props.id}>
            <Select
              label="Mention a person"
              value=""
              disabled={props.locked}
              hint="Choose people who already have access to this task."
              options={[
                { value: '', label: 'No mentions' },
                ...value.persons
                  .filter((person) => !props.selected.includes(person.personId))
                  .map((person) => ({ value: person.personId, label: person.name })),
              ]}
              onChange={(id) => props.onChange(id === '' ? [] : [...props.selected, id])}
            />
            <MentionChips {...props} people={value.persons} />
          </div>
        )}
      </RecordState>
    </>
  );
}

function MentionChips(
  props: Omit<MentionsProps, 'people'> & { readonly people: PersonListResult['persons'] },
) {
  return (
    <div className="tf__tagvalue">
      {props.people
        .filter((person) => props.selected.includes(person.personId))
        .map((person) => (
          <span className="tf__tag" data-mention-person={person.personId} key={person.personId}>
            {person.name}
            <button
              type="button"
              className="btn btn--ghost"
              disabled={props.locked}
              aria-label={`Remove mention of ${person.name}`}
              onClick={() => props.onChange(props.selected.filter((id) => id !== person.personId))}
            >
              ×
            </button>
          </span>
        ))}
    </div>
  );
}

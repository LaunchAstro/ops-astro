// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type KeyboardEvent } from 'react';
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
  readonly enabled: boolean;
  readonly id: string;
  readonly selected: readonly string[];
  readonly locked: boolean;
  readonly clearLocked: boolean;
  readonly body: string;
  readonly textboxId: string;
  readonly placeholder: string;
  readonly onChange: (ids: readonly string[], body?: string) => void;
  readonly onBody: (body: string) => void;
  readonly onSend: () => void;
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

/** An at-sign starts a suggestion list; choosing binds the displayed name to its person id. */
export function InternalTaskMentions(props: MentionsProps) {
  const [caret, setCaret] = useState(props.body.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const people = props.people;
  const match = /(?:^|\s)@([^@\n]{0,40})$/u.exec(props.body.slice(0, caret));
  const query = match?.[1] ?? null;
  const candidates =
    people.own && people.state.outcome === 'ready' && query !== null
      ? people.state.value.persons.filter(
          (person) =>
            !props.selected.includes(person.personId) &&
            person.name.toLowerCase().includes(query.toLowerCase()),
        )
      : [];
  const open = props.enabled && query !== null && dismissed !== props.body && !props.locked;
  const choose = (index: number): void => {
    const person = candidates[index];
    if (person === undefined || query === null || props.locked) return;
    const start = caret - query.length - 1;
    const prefix = props.body.slice(0, start) + '@' + person.name + ' ';
    const next = prefix + props.body.slice(caret);
    props.onChange([...props.selected, person.personId], next);
    setCaret(prefix.length);
    setDismissed(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(prefix.length, prefix.length);
    });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive((index) =>
        Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))),
      );
    } else if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(props.body);
    } else if (open && event.key === 'Enter') {
      event.preventDefault();
      choose(Math.min(active, candidates.length - 1));
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      props.onSend();
    }
  };
  return (
    <div className="comment-editor" data-internal-task-mentions={props.id}>
      <textarea
        ref={input}
        id={props.textboxId}
        className="input"
        rows={1}
        required
        aria-label="Say something"
        placeholder={props.placeholder}
        disabled={props.locked}
        value={props.body}
        aria-autocomplete={props.enabled ? 'list' : undefined}
        aria-controls={open ? props.id : undefined}
        aria-activedescendant={
          open && candidates.length > 0
            ? `${props.id}-${Math.min(active, candidates.length - 1)}`
            : undefined
        }
        onKeyDown={onKey}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onChange={(event) => {
          props.onBody(event.target.value);
          setCaret(event.target.selectionStart);
          setActive(0);
          setDismissed(null);
        }}
      />
      {open ? (
        <div className="mention-menu">
          <RecordState state={people.state} subject="people" onRetry={people.reload}>
            {() => (
              <ul className="menu" role="listbox" id={props.id} aria-label="Mention a person">
                {candidates.map((person, index) => (
                  <li
                    role="option"
                    aria-selected={index === active}
                    id={`${props.id}-${index}`}
                    className={`menu__opt${index === active ? ' is-active' : ''}`}
                    key={person.personId}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                  >
                    @{person.name}
                  </li>
                ))}
                {candidates.length === 0 ? (
                  <li className="menu__empty">No matching people</li>
                ) : null}
              </ul>
            )}
          </RecordState>
        </div>
      ) : null}
      {props.enabled &&
      !open &&
      props.selected.length > 0 &&
      people.own &&
      people.state.outcome !== 'ready' ? (
        <RecordState state={people.state} subject="people" onRetry={people.reload}>
          {() => null}
        </RecordState>
      ) : null}
      {!props.enabled || props.selected.length === 0 ? null : (
        <>
          <MentionChips
            {...props}
            people={
              people.own && people.state.outcome === 'ready' ? people.state.value.persons : []
            }
          />
          <button
            className="comment-editor__clear"
            type="button"
            data-mention-clear
            disabled={props.clearLocked}
            onClick={() => props.onChange([])}
          >
            Clear mentions
          </button>
        </>
      )}
    </div>
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
            @{person.name}
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

// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type KeyboardEvent } from 'react';
import type { PersonListResult } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead, type UseReadLive } from '../../data/use-read.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import { editedMentions, seedMentions, type MentionBinding } from './mention-bindings.ts';
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
  body: string,
): boolean {
  if (selected.length === 0) return false;
  const state = people.state;
  return (
    !people.own ||
    state.outcome !== 'ready' ||
    seedMentions(body, selected, state.value.persons).length !== selected.length
  );
}

/** An at-sign starts a suggestion list; choosing binds the displayed name to its person id. */
export function CommentComposer(props: MentionsProps) {
  const editor = useMentionEditor(props);
  return (
    <div className="comment-editor" data-internal-task-mentions={props.id}>
      <MentionInput {...props} editor={editor} />
      <MentionSuggestions {...props} editor={editor} />
      <MentionRecovery {...props} open={editor.open} />
    </div>
  );
}

// oxlint-disable-next-line max-lines-per-function -- caret, keyboard selection and dismissal share one editor controller.
function useMentionEditor(props: MentionsProps) {
  const [caret, setCaret] = useState(props.body.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const people = props.people;
  const vocabulary =
    people.own && people.state.outcome === 'ready' ? people.state.value.persons : [];
  const names = vocabulary.map((person) => person.name);
  const bindings = useRef<readonly MentionBinding[] | null>(null);
  if (bindings.current === null && vocabulary.length > 0)
    bindings.current = seedMentions(props.body, props.selected, vocabulary);
  const recipientsIn = (body: string, at: number): readonly string[] => {
    const known = new Set([
      ...vocabulary.map((person) => person.personId),
      ...(bindings.current ?? []).map((binding) => binding.id),
    ]);
    // An unavailable vocabulary cannot seed a kept draft. Leave it unseeded
    // until the admitted names arrive, while still translating known tokens.
    if (bindings.current !== null)
      bindings.current = editedMentions(props.body, body, bindings.current, names, at);
    return props.selected.filter((id) =>
      known.has(id)
        ? bindings.current?.some((binding) => binding.id === id)
        : /(?:^|[^\p{L}\p{N}_@])@/u.test(body),
    );
  };
  const match = /(?:^|[^\p{L}\p{N}_@])@([^@\n]{0,40})$/u.exec(props.body.slice(0, caret));
  const typedQuery = match?.[1] ?? null;
  const tokenStart = typedQuery === null ? -1 : caret - typedQuery.length - 1;
  const completed = bindings.current?.some(
    (binding) =>
      binding.start === tokenStart &&
      props.selected.includes(binding.id) &&
      caret > binding.end &&
      !names.some((name) => name.startsWith(typedQuery ?? '')),
  );
  const query = completed ? null : typedQuery;
  const candidates =
    query === null
      ? []
      : vocabulary.filter(
          (person) =>
            !props.selected.includes(person.personId) &&
            person.name.toLowerCase().includes(query.toLowerCase()),
        );
  const open = props.enabled && query !== null && dismissed !== props.body && !props.locked;
  const choose = (index: number): void => {
    const person = candidates[index];
    if (person === undefined || query === null || props.locked) return;
    const start = caret - query.length - 1;
    const prefix = props.body.slice(0, start) + '@' + person.name + ' ';
    const next = prefix + props.body.slice(caret);
    const kept = recipientsIn(next, prefix.length);
    bindings.current = [
      ...(bindings.current ?? []),
      { id: person.personId, name: person.name, start, end: prefix.length - 1 },
    ];
    props.onChange([...kept, person.personId], next);
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
    } else if (open && candidates.length > 0 && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      choose(Math.min(active, candidates.length - 1));
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      props.onSend();
    }
  };
  return {
    input,
    open,
    candidates,
    active,
    choose,
    onKey,
    setCaret,
    setActive,
    setDismissed,
    people,
    recipientsIn,
  };
}

function MentionInput(
  props: MentionsProps & { readonly editor: ReturnType<typeof useMentionEditor> },
) {
  const { input, open, candidates, active, onKey, setCaret, setActive, setDismissed } =
    props.editor;
  return (
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
        props.onChange(
          props.editor.recipientsIn(event.target.value, event.target.selectionStart),
          event.target.value,
        );
        setCaret(event.target.selectionStart);
        setActive(0);
        setDismissed(null);
      }}
    />
  );
}

function MentionSuggestions(
  props: MentionsProps & { readonly editor: ReturnType<typeof useMentionEditor> },
) {
  const { open, candidates, active, choose, people } = props.editor;
  return (
    <>
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
    </>
  );
}

function MentionRecovery(props: MentionsProps & { readonly open: boolean }) {
  const people = props.people;
  const open = props.open;
  return (
    <>
      {props.enabled &&
      !open &&
      props.selected.length > 0 &&
      people.own &&
      people.state.outcome !== 'ready' ? (
        <RecordState state={people.state} subject="people" onRetry={people.reload}>
          {() => null}
        </RecordState>
      ) : null}
      {!props.enabled || !unavailableMentions(people, props.selected, props.body) ? null : (
        <>
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
    </>
  );
}

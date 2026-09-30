// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's tags (MP-4-11, CS-4.19 to CS-4.21; DP-26 to DP-28).
//
// The task's tags are chips, each with a × that removes it
// (`task.remove_tag`). The field is a combobox: focus loads the business's
// vocabulary once (`tag.list`) and opens the menu; typing filters it
// (`tag-rows.ts`), which sends nothing; ↑ and ↓ move the marked row; Enter or
// a press chooses it. An existing tag goes on through `task.add_tag`; the
// "new tag" row creates the name (`tag.create`), then adds it. Typed text is
// never a tag until a row is chosen: leaving the field keeps nothing.
//
// **The menu's Escape is the menu's.** It closes the menu and is marked
// handled, so the panel around it stays open (TR-A3-3).

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TagListResult,
  TagView,
} from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { tagRows, type TagRow } from './tag-rows.ts';

export interface TagFieldProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly onChanged: () => void;
}

/** The new name, then the task carrying it; a refusal of either is the answer. */
async function createThenAdd(
  client: OperationsClient,
  recordId: string,
  name: string,
): Promise<CallResult<CommandOutcome>> {
  const made = await client.mutate('tag.create', { name });
  if (isRefusal(made) || isUnavailable(made)) return made;
  const tagId = made.value.detail?.['tagId'];
  return await client.mutate('task.add_tag', { recordId, tagId });
}

/** The vocabulary, read once on the first focus and again after a new name. */
function useVocabulary(client: OperationsClient) {
  const [tags, setTags] = useState<readonly TagView[] | null>(null);
  const load = async (): Promise<void> => {
    if (tags !== null) return;
    const answer = await client.read<TagListResult>('tag.list', {});
    setTags(isRefusal(answer) || isUnavailable(answer) ? [] : answer.value.tags);
  };
  return { tags, load, forget: () => setTags(null) };
}

/** What is typed, whether the menu is open, and its marked row, which typing resets. */
function useFieldState() {
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const [marked, mark] = useState(0);
  const type = (text: string): void => {
    setTyped(text);
    mark(0);
  };
  return { typed, type, open, setOpen, marked, mark };
}

interface Menu {
  readonly open: boolean;
  readonly rows: readonly TagRow[];
  readonly marked: number;
  readonly mark: (index: number) => void;
  readonly choose: (row: TagRow) => void;
  readonly close: () => void;
}

/** ↑ and ↓ move the marked row, Enter chooses it, and Escape closes only the menu. */
function onMenuKey(event: KeyboardEvent<HTMLInputElement>, menu: Menu): void {
  if (event.key === 'Escape' && menu.open) {
    event.preventDefault();
    event.stopPropagation();
    menu.close();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    menu.mark(Math.min(Math.max(menu.marked + step, 0), Math.max(menu.rows.length - 1, 0)));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = menu.rows[menu.marked];
    if (row !== undefined) menu.choose(row);
  }
}

/** The three writes: add a chosen tag, create a new one and add it, remove one. */
function useTagWrites(
  props: TagFieldProps,
  field: ReturnType<typeof useFieldState>,
  vocabulary: ReturnType<typeof useVocabulary>,
) {
  const { client, task } = props;
  const { busy, because, run } = useCommand();
  const landed = (settlement: { readonly kind: string }): void => {
    if (settlement.kind !== 'ok') return;
    field.type('');
    props.onChanged();
  };
  const choose = (row: TagRow): void => {
    field.setOpen(false);
    if (row.kind === 'tag') {
      run(() => client.mutate('task.add_tag', { recordId: task.id, tagId: row.tag.id }), landed);
    } else {
      vocabulary.forget();
      run(() => createThenAdd(client, task.id, row.name), landed);
    }
  };
  const remove = (tag: TagView): void =>
    run(() => client.mutate('task.remove_tag', { recordId: task.id, tagId: tag.id }), landed);
  return { busy, because, choose, remove };
}

export function TagField(props: TagFieldProps): ReactElement {
  const { task } = props;
  const vocabulary = useVocabulary(props.client);
  const field = useFieldState();
  const { busy, because, choose, remove } = useTagWrites(props, field, vocabulary);
  const rows =
    field.open && vocabulary.tags !== null ? tagRows(vocabulary.tags, task.tags, field.typed) : [];
  const menu: Menu = { ...field, rows, choose, close: () => field.setOpen(false) };
  return (
    <div className="tf__tags" data-panel-field="tags">
      <span className="tf__k">Tags</span>
      <TagChips tags={task.tags} busy={busy} onRemove={remove} />
      <TagInput
        placeholder={task.tags.length === 0 ? 'Add a tag…' : 'Add another…'}
        busy={busy}
        typed={field.typed}
        expanded={rows.length > 0}
        onFocus={() => {
          field.setOpen(true);
          void vocabulary.load();
        }}
        onBlur={() => field.setOpen(false)}
        onType={(text) => {
          field.type(text);
          field.setOpen(true);
        }}
        onKeyDown={(event) => onMenuKey(event, menu)}
      />
      <TagMenu {...menu} />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}

/** The combobox itself; what its focus, typing and keys do is the field's. */
function TagInput(props: {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly typed: string;
  readonly expanded: boolean;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onType: (text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}): ReactElement {
  return (
    <input
      id="panel-tag-input"
      className="input"
      role="combobox"
      aria-label="Add a tag"
      aria-expanded={props.expanded}
      aria-controls="panel-tag-menu"
      aria-autocomplete="list"
      placeholder={props.placeholder}
      disabled={props.busy}
      value={props.typed}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onChange={(event) => props.onType(event.target.value)}
      onKeyDown={props.onKeyDown}
    />
  );
}

/** The task's tags, each with the × that takes it off this task. */
function TagChips(props: {
  readonly tags: readonly TagView[];
  readonly busy: boolean;
  readonly onRemove: (tag: TagView) => void;
}): ReactElement {
  return (
    <>
      {props.tags.map((tag) => (
        <span key={tag.id} className="chip" data-tag-chip={tag.id}>
          {tag.name}
          <button
            className="chip__x"
            type="button"
            aria-label={`Remove the tag ${tag.name}`}
            disabled={props.busy}
            onClick={() => props.onRemove(tag)}
          >
            ×
          </button>
        </span>
      ))}
    </>
  );
}

/** The suggestions and the "new tag" row; hidden when there is nothing to offer. */
function TagMenu(props: Menu): ReactElement | null {
  if (props.rows.length === 0) return null;
  return (
    <ul id="panel-tag-menu" className="menu" role="listbox" aria-label="Tags">
      {props.rows.map((row, index) => (
        <li
          key={row.kind === 'tag' ? row.tag.id : 'new'}
          role="option"
          aria-selected={index === props.marked}
          data-tag-row={row.kind === 'tag' ? row.tag.id : 'new'}
          // The field keeps focus through the press, so its blur does not
          // close the menu before the click chooses; the keys are the
          // field's (↑, ↓, Enter).
          onMouseDown={(event) => event.preventDefault()}
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
          onClick={() => props.choose(row)}
        >
          {row.kind === 'tag' ? row.tag.name : `New tag “${row.name}”`}
        </li>
      ))}
    </ul>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-dos list's tools (MP-7-1, CS-7.23): the token search, its chips and
// its "Reading this as" line (PJ-02 to PJ-04, drawn as the mockup's
// `.tsearch`), the today scope, dropping the scope and the door to the board.
// The sort is the column heads' (`TodoHead.tsx`). Enter turns the typed words
// into chips, a chip's cross removes it, and Backspace in the empty box drops
// the last one. None of them writes.

import type { ReactElement } from 'react';
import { wordsOfChip, type Chip } from './todo-list.ts';

export interface TodoToolsProps {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly chips: readonly Chip[];
  /** Enter: the typed words become chips. */
  readonly onCommit: () => void;
  readonly onRemove: (index: number) => void;
  /** The scope read back, or null when nothing scopes the list. */
  readonly reading: string | null;
  readonly onClear: () => void;
  readonly boardAddress?: string;
}

export function TodoTools(props: TodoToolsProps): ReactElement {
  return (
    <div className="tsearch todos__tools">
      <SearchBox {...props} />
      <div className="todos__acts">
        <button
          className="btn"
          type="button"
          data-todos="today"
          onClick={() => props.onQuery('due:today')}
        >
          Today
        </button>
        <a
          className="btn"
          data-todos="board"
          href={props.boardAddress}
          aria-disabled={props.boardAddress === undefined ? true : undefined}
        >
          Open the board
        </a>
      </div>
      <Reading reading={props.reading} onClear={props.onClear} />
    </div>
  );
}

/** The box: the chips, then the typed words. */
function SearchBox(props: TodoToolsProps): ReactElement {
  return (
    <div className="tsearch__tags">
      {props.chips.map((chip, index) => (
        <ChipTag key={index} chip={chip} onRemove={() => props.onRemove(index)} />
      ))}
      <input
        id="todos-search"
        className="tsearch__in"
        type="search"
        autoComplete="off"
        placeholder={PLACEHOLDER}
        aria-label={`Search my to-dos: ${PLACEHOLDER}`}
        value={props.query}
        onChange={(event) => {
          props.onQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') props.onCommit();
          if (event.key === 'Backspace' && props.query === '' && props.chips.length > 0) {
            props.onRemove(props.chips.length - 1);
          }
        }}
      />
    </div>
  );
}

const PLACEHOLDER = 'today, p1, person:"name", client:"name", route:team, tag:name, any words';

function ChipTag(props: { readonly chip: Chip; readonly onRemove: () => void }): ReactElement {
  const words = wordsOfChip(props.chip);
  return (
    <span className="tsearch__tag" data-todos-chip={props.chip.kind}>
      <span className="tsearch__kind">{words.kind}</span> {words.value}
      <button
        className="tsearch__x"
        type="button"
        aria-label={`Remove ${words.reading}`}
        data-todos-chip-remove
        onClick={props.onRemove}
      >
        ×
      </button>
    </span>
  );
}

function Reading(props: {
  readonly reading: string | null;
  readonly onClear: () => void;
  readonly boardAddress?: string;
}): ReactElement | null {
  if (props.reading === null) return null;
  return (
    <p className="tsearch__read u-mono">
      <span data-todos-reading>{props.reading}</span>{' '}
      <button className="btn" type="button" data-todos="clear" onClick={props.onClear}>
        Drop the scope
      </button>
    </p>
  );
}

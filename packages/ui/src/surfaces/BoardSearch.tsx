// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's search field and its typeahead (MP-5-5, B-01, B-03). From two
// characters it suggests filters and row names; arrows move, Enter takes the
// marked suggestion or commits what was typed, Escape and a press outside
// close it, and Backspace in an empty field drops the last filter. Group
// headings and the "+n more" line are presentation, so the keyboard only ever
// lands on an option.

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { suggest } from '../board/typeahead.ts';
import type { Facet, Filters, SuggestionItem } from '../board/types.ts';

export interface BoardSearchProps<Row> {
  readonly facets: readonly Facet<Row>[];
  readonly names: readonly string[];
  readonly noun: string;
  /** What is already on; it is never suggested again. */
  readonly have: Filters;
  readonly onCommit: (raw: string) => void;
  readonly onTake: (item: SuggestionItem) => void;
  readonly onDropLast: () => void;
}

export function BoardSearch<Row>(props: BoardSearchProps<Row>): ReactElement {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const listId = useId();

  const groups = open
    ? suggest({
        q: draft,
        facets: props.facets,
        names: props.names,
        noun: props.noun,
        have: props.have,
      })
    : [];
  const items = groups.flatMap((group) => group.items);
  const offsets = groups.map((_, index) =>
    groups.slice(0, index).reduce((sum, group) => sum + group.items.length, 0),
  );

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Node && host.current?.contains(event.target) !== true)
        setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [open]);

  const done = (): void => {
    setDraft('');
    setOpen(false);
    setActive(0);
  };
  const take = (item: SuggestionItem): void => {
    props.onTake(item);
    done();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const marked = items[active];
      if (marked !== undefined) {
        take(marked);
      } else if (draft.trim() !== '') {
        props.onCommit(draft);
        done();
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Backspace' && draft === '') {
      props.onDropLast();
    }
  };

  const any = props.have.ids.length > 0 || props.have.text.length > 0;
  return (
    <div className="cbdm__search" ref={host}>
      <input
        className="cbd__barq"
        data-board-search=""
        type="search"
        role="combobox"
        aria-label={`Search ${props.noun}s`}
        aria-expanded={groups.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={any ? 'Add another…' : `Filter ${props.noun}s…`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {groups.length === 0 ? null : (
        <ul className="cbdta" role="listbox" id={listId}>
          {groups.map((group, index) => (
            <Fragment key={group.label}>
              <li className="cbdta__gh" role="presentation">
                {group.label}
              </li>
              {group.items.map((item, at) => (
                <li
                  key={`${item.kind}:${item.label}`}
                  className="sel__opt cbdta__opt"
                  role="option"
                  aria-selected={(offsets[index] ?? 0) + at === active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    take(item);
                  }}
                >
                  {item.label}
                  <span className="cbdta__k">{item.kind}</span>
                </li>
              ))}
              {group.more > 0 ? (
                <li className="cbdta__more" role="presentation">
                  +{group.more} more — keep typing
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}

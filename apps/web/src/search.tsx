// SPDX-License-Identifier: AGPL-3.0-only
//
// Search across what the person may see, by click or ⌘K (C1). The palette
// asks the one scoped query service, `task.search` (C1a), whose scope is in
// the statement that finds candidates, and draws exactly what it answered: the
// hits it may show, "nothing found" with no count, or a refusal with no title,
// id or count. Enter or a click opens the chosen task. The portal has no search
// until a client search is designed.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { SearchHit, TaskSearchResult } from '../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from './operations/client.ts';
import { pathTo } from './routes.ts';

/** How long typing rests before the service is asked. */
const REST_MS = 200;

type Answer =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hits'; readonly hits: readonly SearchHit[] }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unavailable' };

const hasWord = (query: string): boolean => /[\p{L}\p{N}]/u.test(query);

/** ⌘K or Ctrl+K opens search wherever `enabled`, and nothing else. */
export function useSearchKey(enabled: boolean, open: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      event.preventDefault();
      open();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled, open]);
}

export function SearchPalette(props: {
  readonly client: OperationsClient;
  readonly onOpen: (address: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const listId = useId();
  const field = useRef<HTMLInputElement | null>(null);
  const asked = useRef(0);
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<Answer>({ kind: 'idle' });
  const [active, setActive] = useState(0);
  const { client, onClose } = props;

  useEffect(() => {
    field.current?.focus();
  }, []);

  // One Escape closes the palette and nothing under it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  useEffect(() => {
    const ask = ++asked.current;
    if (!hasWord(query)) {
      setAnswer({ kind: 'idle' });
      return undefined;
    }
    const rest = setTimeout(() => {
      void client.read<TaskSearchResult>('task.search', { query }).then((result) => {
        // Only the latest question's answer is drawn.
        if (ask !== asked.current) return result;
        setActive(0);
        if ('ok' in result) setAnswer({ kind: 'hits', hits: result.value.hits });
        else setAnswer({ kind: 'unavailable' in result ? 'unavailable' : 'refused' });
        return result;
      });
    }, REST_MS);
    return () => {
      clearTimeout(rest);
    };
  }, [client, query]);

  const hits = answer.kind === 'hits' ? answer.hits : [];
  const pick = (hit: SearchHit | undefined): void => {
    if (hit === undefined) return;
    props.onOpen(pathTo('agency:task-detail', { key: hit.key }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((at) => (at + step + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(hits[active]);
    }
  };
  const optionId = (index: number): string => `${listId}-${index}`;

  return (
    <>
      <div className="palette__scrim" aria-hidden="true" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={field}
          className="palette__field"
          type="search"
          role="combobox"
          aria-label="Search tasks"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(hits.length > 0 ? { 'aria-activedescendant': optionId(active) } : {})}
          placeholder="Search tasks…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette__list" role="listbox" id={listId} aria-label="Results">
          {hits.map((hit, index) => (
            <li
              key={hit.id}
              id={optionId(index)}
              className="palette__hit"
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                pick(hit);
              }}
            >
              <span className="palette__key">{hit.key}</span>
              <span className="palette__title">{hit.title ?? ''}</span>
            </li>
          ))}
        </ul>
        {answer.kind === 'hits' && hits.length === 0 ? (
          <p className="palette__none">Nothing found.</p>
        ) : null}
        {answer.kind === 'refused' ? (
          <p className="palette__none">Search is not open to you here.</p>
        ) : null}
        {answer.kind === 'unavailable' ? (
          <p className="palette__none">Search could not be reached. Try again.</p>
        ) : null}
      </div>
    </>
  );
}

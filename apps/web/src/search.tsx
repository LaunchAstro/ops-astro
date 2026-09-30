// SPDX-License-Identifier: AGPL-3.0-only
//
// Search across what the person may see, by click or ⌘K (C1). The palette
// asks the one scoped query service, `task.search` (C1a), whose scope is in
// the statement that finds candidates, and draws exactly what it answered: the
// hits it may show, "nothing found" with no count, or a refusal with no title,
// id or count. Enter or a click opens the chosen task. The portal has no search
// until a client search is designed.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
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

/**
 * Search's own state: open or not is the application's; the strip's box and
 * ⌘K open it on the agency face only, and closing returns focus to the box.
 * `dismiss` closes it without moving focus, for a hit that navigates away.
 */
export function useSearch(): {
  readonly showing: boolean;
  readonly box: RefObject<HTMLButtonElement | null>;
  readonly open: () => void;
  readonly close: () => void;
  readonly dismiss: () => void;
} {
  const [showing, setShowing] = useState(false);
  const box = useRef<HTMLButtonElement | null>(null);
  const open = useCallback(() => {
    setShowing(true);
  }, []);
  const close = useCallback(() => {
    setShowing(false);
    box.current?.focus();
  }, []);
  const dismiss = useCallback(() => {
    setShowing(false);
  }, []);
  return { showing, box, open, close, dismiss };
}

/** ⌘K or Ctrl+K opens search wherever `enabled`, and nothing else. */
export function useSearchKey(enabled: boolean, open: () => void): void {
  useEffect(() => {
    if (!enabled) return;
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
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const answer = useAnswer(props.client, query, setActive);
  const { onClose } = props;
  useFocusAndOneEscape(field, onClose);

  const hits = answer.kind === 'hits' ? answer.hits : [];
  const pick = (hit: SearchHit | undefined): void => {
    if (hit === undefined) return;
    props.onOpen(pathTo('agency:task-detail', { key: hit.key }));
  };

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
          {...(hits.length > 0 ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
          placeholder="Search tasks…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            onPaletteKey(event, hits.length, setActive, () => {
              pick(hits[active]);
            });
          }}
        />
        <HitList listId={listId} hits={hits} active={active} onPick={pick} />
        <AnswerNote answer={answer} />
      </div>
    </>
  );
}

/** Focus goes to the field on open; one Escape closes the palette and nothing under it. */
function useFocusAndOneEscape(
  field: RefObject<HTMLInputElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    field.current?.focus();
  }, [field]);
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
}

/**
 * The service's answer to `query`, asked once typing has rested; a new answer
 * moves the highlight back to the first hit through `setActive`.
 */
function useAnswer(
  client: OperationsClient,
  query: string,
  setActive: (index: number) => void,
): Answer {
  const asked = useRef(0);
  const [answer, setAnswer] = useState<Answer>({ kind: 'idle' });
  useEffect(() => {
    const ask = ++asked.current;
    if (!hasWord(query)) {
      setAnswer({ kind: 'idle' });
      return;
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
  }, [client, query, setActive]);
  return answer;
}

/** Arrows move the highlight round the hits; Enter opens the highlighted one. */
function onPaletteKey(
  event: KeyboardEvent<HTMLInputElement>,
  count: number,
  setActive: (next: (at: number) => number) => void,
  openActive: () => void,
): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (count === 0) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    setActive((at) => (at + step + count) % count);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    openActive();
  }
}

function HitList(props: {
  readonly listId: string;
  readonly hits: readonly SearchHit[];
  readonly active: number;
  readonly onPick: (hit: SearchHit) => void;
}): ReactElement {
  return (
    <ul className="palette__list" role="listbox" id={props.listId} aria-label="Results">
      {props.hits.map((hit, index) => (
        <li
          key={hit.id}
          id={`${props.listId}-${index}`}
          className="palette__hit"
          role="option"
          aria-selected={index === props.active}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            props.onPick(hit);
          }}
        >
          <span className="palette__key">{hit.key}</span>
          <span className="palette__title">{hit.title ?? ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** What the answer says when it has no hit to list: nothing, "nothing found", a refusal, or unreachable. */
function AnswerNote(props: { readonly answer: Answer }): ReactElement | null {
  const { kind } = props.answer;
  if (kind === 'hits' && props.answer.hits.length === 0) {
    return <p className="palette__none">Nothing found.</p>;
  }
  if (kind === 'refused') return <p className="palette__none">Search is not open to you here.</p>;
  if (kind === 'unavailable') {
    return <p className="palette__none">Search could not be reached. Try again.</p>;
  }
  return null;
}

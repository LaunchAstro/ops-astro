// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision refused for want of the grant closes that task's gate controls
// in every view of it: the task page's Agent pane and the dock panel's Agent
// side ("closed in either view, closed in both"). Each view still holds its
// own note above its read; the closures are shared here, by task, for one
// business and person. A switch of either draws none of them. The server
// stays the authority: this is only what the views offer.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { DecisionNote } from './gate-controls.tsx';

interface Closures {
  readonly notes: ReadonlyMap<string, DecisionNote>;
  readonly close: (taskId: string, note: DecisionNote) => void;
}

const NONE: ReadonlyMap<string, DecisionNote> = new Map();
const Shared = createContext<Closures | null>(null);

/** `owner` is the tab's grant key: closures are held for it alone. */
export function DecisionClosures(props: {
  readonly owner: string;
  readonly children: ReactNode;
}): ReactElement {
  const { owner } = props;
  const [held, setHeld] = useState({ owner, notes: NONE });
  // A switch drops every closure, so switching back brings none of them back.
  if (held.owner !== owner) setHeld({ owner, notes: NONE });
  const notes = held.owner === owner ? held.notes : NONE;
  const close = useCallback(
    (taskId: string, note: DecisionNote) => {
      setHeld((current) => ({
        owner,
        notes: new Map(current.owner === owner ? current.notes : NONE).set(taskId, note),
      }));
    },
    [owner],
  );
  const value = useMemo(() => ({ notes, close }), [notes, close]);
  return <Shared.Provider value={value}>{props.children}</Shared.Provider>;
}

/**
 * The note one view of `taskId` draws: its own closure, else another view's
 * closure of the same task, else its own note. A closure it is told of is
 * shared with the other views.
 */
export function useSharedNote(
  taskId: string,
  note: DecisionNote | null,
  onDecided: (note: DecisionNote | null) => void,
): { readonly note: DecisionNote | null; readonly onDecided: (note: DecisionNote | null) => void } {
  const shared = useContext(Shared);
  const closed = shared?.notes.get(taskId) ?? null;
  return {
    note: note?.closed === true ? note : (closed ?? note),
    onDecided: (next) => {
      onDecided(next);
      if (next?.closed === true) shared?.close(taskId, next);
    },
  };
}

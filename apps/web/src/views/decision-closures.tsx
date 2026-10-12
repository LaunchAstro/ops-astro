// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision refused for want of the grant closes that task's gate controls
// in every view of it: the task page's Agent pane and the dock panel's Agent
// side ("closed in either view, closed in both"). Each view still holds its
// own note above its read; the closures are shared here, by task, for one
// business and person. A switch of either draws none of them, and a refusal
// that settles after a switch closes nothing. A read of the task answering
// denied drops its closure, as each view's own note is dropped. The server
// stays the authority: this is only what the views offer.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { DecisionNote } from './gate-controls.tsx';

/** A task as both views know it: the page by its address, the panel by its opening. */
interface TaskNamed {
  readonly id: string;
  readonly key: string;
}

type Notes = ReadonlyMap<string, { readonly key: string; readonly note: DecisionNote }>;

interface Closures {
  readonly notes: Notes;
  readonly close: (task: TaskNamed, note: DecisionNote) => void;
  readonly forget: (address: string) => void;
}

const NONE: Notes = new Map();
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
  // Both write only for the owner they were made under: a late refusal from
  // before a switch, settling after it, changes nothing.
  const close = useCallback(
    (task: TaskNamed, note: DecisionNote) => {
      setHeld((current) =>
        current.owner === owner
          ? { owner, notes: new Map(current.notes).set(task.id, { key: task.key, note }) }
          : current,
      );
    },
    [owner],
  );
  const forget = useCallback(
    (address: string) => {
      setHeld((current) => {
        const kept = [...current.notes].filter(
          ([id, { key }]) => id !== address && key !== address,
        );
        return current.owner !== owner || kept.length === current.notes.size
          ? current
          : { owner, notes: new Map(kept) };
      });
    },
    [owner],
  );
  const value = useMemo(() => ({ notes, close, forget }), [notes, close, forget]);
  return <Shared.Provider value={value}>{props.children}</Shared.Provider>;
}

/**
 * The note one view of `task` draws: its own closure, else another view's
 * closure of the same task, else its own note. A closure it is told of is
 * shared with the other views.
 */
export function useSharedNote(
  task: TaskNamed,
  note: DecisionNote | null,
  onDecided: (note: DecisionNote | null) => void,
): { readonly note: DecisionNote | null; readonly onDecided: (note: DecisionNote | null) => void } {
  const shared = useContext(Shared);
  const closed = shared?.notes.get(task.id)?.note ?? null;
  return {
    note: note?.closed === true ? note : (closed ?? note),
    onDecided: (next) => {
      onDecided(next);
      if (next?.closed === true) shared?.close(task, next);
    },
  };
}

/** A view's read of the task at `address` (its key or id) answering denied drops its shared closure. */
export function useForgetOnDenial(address: string, denied: boolean): void {
  const forget = useContext(Shared)?.forget;
  useEffect(() => {
    if (denied) forget?.(address);
  }, [address, denied, forget]);
}

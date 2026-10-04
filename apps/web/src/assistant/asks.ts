// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: an ask from a page that is not an entry-point sparkle, carried to the
// dock's drawer. The Agent pane's "Start a new attempt" is the one today: a
// new attempt is a new plan, and a plan is accepted in the drawer, so the pane
// asks the drawer to plan it (`AW-04 start from the pane`).
//
// The pane sits deep in the task page and the drawer is the dock's, so the ask
// travels as one window event rather than a prop threaded through the shell.
// The dock's half (`useAgentDrawer`) opens the drawer on it; the drawer's half
// (`useAsks`) takes the ask that opened it, then each later one while open.
// The drawer drafts the question and sends nothing until the person does.
// An ask carries the grant key of the session that made it, and a drawer takes
// only its own session's: one left waiting never reaches a later sign-in.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AskEntry } from './chats.ts';
import type { ScopeInput } from './subject.ts';

const ASK_EVENT = 'ops-astro:assistant-ask';

/** The ask no open drawer has taken yet, the one opening it, and whose session made it. */
let pending: { readonly entry: AskEntry; readonly grantKey: string } | null = null;

/** Asks the dock's drawer, under the session `grantKey` names, to open on `entry`. */
export function askDrawer(entry: AskEntry, grantKey: string): void {
  pending = { entry, grantKey };
  window.dispatchEvent(new Event(ASK_EVENT));
}

function useHeard(heard: () => void): void {
  useEffect(() => {
    window.addEventListener(ASK_EVENT, heard);
    return () => {
      window.removeEventListener(ASK_EVENT, heard);
    };
    // Each half's `heard` only sets state, so the first one serves.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The dock's drawer, open or not; an ask opens it. */
export function useAgentDrawer(): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(false);
  useHeard(() => {
    setOpen(true);
  });
  return [open, setOpen];
}

/**
 * The drawer's half: `take` gets the ask that opened it, then each one made
 * while it is open, each only if made under the drawer's own `grantKey`.
 */
export function useAsks(grantKey: string | undefined, take: (entry: AskEntry) => void): void {
  const taken = (): void => {
    const ask = pending;
    pending = null;
    if (ask !== null && ask.grantKey === grantKey) take(ask.entry);
  };
  useEffect(() => {
    taken();
    // The drawer closing, or its session ending, drops an ask it never took.
    return () => {
      pending = null;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useHeard(taken);
}

/** The pane's ask: plan a new attempt at this task, the task in scope (DA-07). */
export function newAttemptAsk(task: NonNullable<ScopeInput['task']>): AskEntry {
  return {
    row: 'DA-07',
    widget: { id: 'start-attempt', label: 'Start a new attempt' },
    question: `Plan a new attempt at ${task.title}.`,
    scope: { client: null, task },
  };
}

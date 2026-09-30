// SPDX-License-Identifier: AGPL-3.0-only
//
// Which task the dock task panel shows, and the count of changes made in it
// (MP-4-8). The application holds one of these; screens reach it as their
// `taskPanel` and the shell draws the panel it names.
//
// **One count for both sides.** A write in the panel counts a change; the
// task page and the panel each read the task again on a new count, so the
// page shows the change at once without a reload and neither guesses it.
//
// **Closing returns focus to the door.** The door is found again by its kind
// on the page (each kind is drawn once there), so a door redrawn by a reread
// since the press still gets the focus back.
//
// **A draft or a task (MP-4-13).** The panel shows one new-task draft or one
// task; opening a task replaces the draft in the panel and the draft stays
// kept for its person (DN-04).
//
// The dock frame (MP-3-1: seat line, float, sheet, back and forward) is not on
// main yet; until it is, this is the whole host and the shell's panel slot is
// its place.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TaskPanelHost } from '../../screen-registry.tsx';
import type { DraftScope } from './DraftPanel.tsx';
import type { PanelOpening } from './Panel.tsx';
import type { ConversationTab, PanelDoor } from './Perspectives.tsx';

export interface TaskPanelState {
  readonly host: TaskPanelHost;
  /** The open panel's task and door, or null when it is closed or shows a draft. */
  readonly opening: PanelOpening | null;
  /** The new-task draft's scope while the panel shows the draft (MP-4-13), else null. */
  readonly draft: DraftScope | null;
  readonly changed: () => void;
  readonly close: () => void;
  readonly openDraft: (scope: DraftScope) => void;
  /** The open task's stop for this person's running timer, or null when none runs. */
  readonly leaving: (stop: (() => void) | null) => void;
}

export function useTaskPanel(): TaskPanelState {
  const [opening, setOpening] = useState<PanelOpening | null>(null);
  const [draft, setDraft] = useState<DraftScope | null>(null);
  const [changes, setChanges] = useState(0);
  // Leaving the task (X, Escape, another task, a draft) stops its running
  // timer through MP-4-6's one stop-and-log step, once (TR-S-PI6-4).
  const stop = useRef<(() => void) | null>(null);
  const leave = useCallback((): void => {
    const pending = stop.current;
    stop.current = null;
    pending?.();
  }, []);
  const open = useCallback(
    (taskKey: string, door: PanelDoor, tab?: ConversationTab) => {
      if (taskKey !== opening?.taskKey) leave();
      setDraft(null);
      setOpening({ taskKey, door, tab: tab ?? null });
    },
    [opening, leave],
  );
  const openDraft = useCallback(
    (scope: DraftScope) => {
      leave();
      setOpening(null);
      setDraft(scope);
    },
    [leave],
  );
  const leaving = useCallback((next: (() => void) | null) => {
    stop.current = next;
  }, []);
  const changed = useCallback(() => {
    setChanges((count) => count + 1);
  }, []);
  const close = useCallback(() => {
    leave();
    const door = opening?.door;
    setOpening(null);
    setDraft(null);
    if (door === undefined) return;
    const opener = document.querySelector<HTMLElement>(`main [data-panel-door="${door}"]`);
    opener?.focus();
  }, [opening, leave]);
  const host = useMemo(() => ({ open, changes }), [open, changes]);
  return { host, opening, draft, changed, close, openDraft, leaving };
}

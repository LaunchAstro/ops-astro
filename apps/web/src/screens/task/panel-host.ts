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
// The dock frame (MP-3-1: seat line, float, sheet, back and forward, and its
// one close path that stops a running timer) is not on main yet; until it is,
// this is the whole host and the shell's panel slot is its place.

import { useCallback, useMemo, useState } from 'react';
import type { TaskPanelHost } from '../../screen-registry.tsx';
import type { DraftScope } from './DraftPanel.tsx';
import type { PanelOpening } from './Panel.tsx';
import type { ConversationTab, PanelDoor } from './Perspectives.tsx';

export interface TaskPanelState {
  readonly host: TaskPanelHost;
  /** The open panel's task and door, or null when it is closed. */
  readonly opening: PanelOpening | null;
  readonly changed: () => void;
  readonly close: () => void;
  readonly openDraft: (scope: DraftScope) => void;
  readonly leaving: (stop: (() => void) | null) => void;
}

export function useTaskPanel(): TaskPanelState {
  const [opening, setOpening] = useState<PanelOpening | null>(null);
  const [changes, setChanges] = useState(0);
  const open = useCallback((taskKey: string, door: PanelDoor, tab?: ConversationTab) => {
    setOpening({ taskKey, door, tab: tab ?? null });
  }, []);
  const changed = useCallback(() => {
    setChanges((count) => count + 1);
  }, []);
  const close = useCallback(() => {
    const door = opening?.door;
    setOpening(null);
    if (door === undefined) return;
    const opener = document.querySelector<HTMLElement>(`main [data-panel-door="${door}"]`);
    opener?.focus();
  }, [opening]);
  const host = useMemo(() => ({ open, changes }), [open, changes]);
  return { host, opening, changed, close, openDraft: () => undefined, leaving: () => undefined };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The task panel (MP-4-8) as the dock's own `task` panel (DOCK.md section 2,
// row 6). Which task or draft it shows lives in the task panel's host
// (screens/task/panel-host.ts); the dock holds `task` in its open set while
// there is one, so the panel takes its place in the rank, the geometry,
// Escape's order and the phone's one panel like any other. Either side
// closing it closes the other: the dock's close, Close all, Escape or a solo
// press end the task panel through its own close (the timer's stop, the focus
// back on its door), and the task panel's own close takes `task` out of the
// dock. While the draft's Create is out the task panel's close refuses
// (A11-1), and the dock puts `task` back beside what is open, so no close
// leaves the draft. Putting it back mounts the draft again, and the draft
// finds its Create still out and waits for it (`DraftPanel.tsx`). The dock's
// own storage and history never bring the id back; the task panel's host
// keeps the open task and opens it again after a reload (S1), beside the rest
// of the dock the person left.
//
// **New task on every page (DOCK T-17, DP-02).** The To-dos panel's head New
// (`dock-props.tsx`) opens a draft filed from the page; the rail keeps the
// registry's doors (R34), so the Task tab shows only while the panel holds
// something. Any `[data-new-task]` control opens a draft too, prefilled from
// the door, through the gesture law (a shift press opens it beside).

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { DockPanel, DockTab } from '@launchastro/ui';
import { PANEL_RANK, type PanelId } from '../panels.ts';
import { close, openByGesture } from './open-set.ts';
import type { DockModel } from './use-dock.ts';
import { doorContext, type PageContext } from '../screens/task/task-prefill.ts';

/** The task panel as the dock draws it. */
export interface TaskDock {
  /** A task or a new-task draft is open. */
  readonly open: boolean;
  readonly body: ReactNode;
  /** The open task's own page, or the board for a draft. */
  readonly door: string;
  /** The task panel's own close; false, closing nothing, while the draft's Create is out. */
  readonly close: () => boolean;
  /** A draft filed from the page or a door; null signed out. */
  readonly file: ((page: PageContext) => void) | null;
}

const LABEL = 'Task';

/** Keeps `task` in the dock's open set exactly while the task panel holds something. */
export function useTaskDock(dock: DockModel, task: TaskDock | null): void {
  const open = task?.open ?? false;
  const docked = dock.state.open.includes('task');
  const last = useRef({ open: false, docked: false });
  const { change } = dock;
  const closeTask = task?.close;
  const file = task?.file ?? null;
  // A door's shift press opens the panel beside what is open. A task open from
  // the first frame is the one kept across a reload: it comes back beside the
  // panels the dock kept, never in their place.
  const beside = useRef(open);
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const door = (event.target as Element | null)?.closest<HTMLElement>('[data-new-task]');
      if (event.defaultPrevented || file === null || door === null || door === undefined) return;
      event.preventDefault();
      // Beside applies to the panel's own open; a panel already open stays where it is.
      beside.current = event.shiftKey && !openNow.current;
      file(doorContext(door));
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  }, [file]);
  // A layout effect: the dock's close drops the panel in the same commit, and
  // the panel's unmount clears the timer's stop in the passive phase after,
  // so the close must run first to send time.stop.
  useLayoutEffect(() => {
    const was = last.current;
    last.current = { open, docked };
    if (open && !was.open) {
      // A row or a door opened a task: the gesture law's plain open.
      const shift = beside.current;
      beside.current = false;
      if (!docked) change((state) => openByGesture(state, 'task', shift));
    } else if (!open && docked) {
      change((state) => close(state, 'task'));
    } else if (open && was.docked && !docked) {
      // The task panel's own close; while the draft's Create is out it closes
      // nothing, and the panel stays, beside what is open.
      const closed = closeTask?.() ?? true;
      if (!closed) change((state) => openByGesture(state, 'task', true));
    }
  }, [open, docked, change, closeTask, file]);
}

const rank = (id: string): number => PANEL_RANK.indexOf(id as PanelId);

/** The rail's tabs, with the Task tab in its rank while the task panel is in the dock. */
export function withTaskTab(
  tabs: readonly DockTab[],
  task: TaskDock | null,
  docked: boolean,
): readonly DockTab[] {
  if (task?.open !== true || !docked) return tabs;
  const mine: DockTab = { id: 'task', label: LABEL, icon: 'list-check', count: null, open: true };
  return [...tabs, mine].toSorted((a, b) => rank(a.id) - rank(b.id));
}

/** The Task panel: the dock's head over the task panel's body. */
export const taskPanelOf = (
  task: TaskDock,
  walked: Pick<DockPanel, 'canBack' | 'canForward' | 'scrollTop'>,
): DockPanel => ({
  id: 'task',
  label: LABEL,
  ariaLabel: 'Task: the task open in the dock',
  door: task.door,
  ...walked,
  body: task.body,
});

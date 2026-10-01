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
// dock. Storage and the history never bring the id back: they hold no task to
// draw, so the dock restores only panels with a registration.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { DockPanel, DockTab } from '@launchastro/ui';
import { PANEL_RANK, type PanelId } from '../panels.ts';
import { close, openByGesture } from './open-set.ts';
import type { DockModel } from './use-dock.ts';

/** The task panel as the dock draws it. */
export interface TaskDock {
  /** A task or a new-task draft is open. */
  readonly open: boolean;
  readonly body: ReactNode;
  /** The open task's own page, or the board for a draft. */
  readonly door: string;
  /** Opened by Shift: beside the open panels, not alone (CS-7.29). */
  readonly beside?: boolean;
  /** The task panel's own close. */
  readonly close: () => void;
}

const LABEL = 'Task';

/** Keeps `task` in the dock's open set exactly while the task panel holds something. */
export function useTaskDock(dock: DockModel, task: TaskDock | null): void {
  const open = task?.open ?? false;
  const beside = task?.beside ?? false;
  const docked = dock.state.open.includes('task');
  const last = useRef({ open: false, docked: false });
  const { change } = dock;
  const closeTask = task?.close;
  // A layout effect: the dock's close drops the panel in the same commit, and
  // the panel's unmount clears the timer's stop in the passive phase after,
  // so the close must run first to send time.stop.
  useLayoutEffect(() => {
    const was = last.current;
    last.current = { open, docked };
    if (open && !was.open) {
      // A row or a door opened a task: plain alone, Shift beside (the gesture law).
      if (!docked) change((state) => openByGesture(state, 'task', beside));
    } else if (!open && docked) {
      change((state) => close(state, 'task'));
    } else if (open && was.docked && !docked) {
      closeTask?.();
    }
  }, [open, docked, beside, change, closeTask]);
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

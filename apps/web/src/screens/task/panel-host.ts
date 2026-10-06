// SPDX-License-Identifier: AGPL-3.0-only
//
// Which task the dock task panel shows, and the count of changes made in it
// (MP-4-8). The application holds one of these; screens reach it as their
// `taskPanel` and the dock draws the panel it names as its `task` panel.
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
// **The panel and the draft end with the session (ruling ORCH57).** Signing
// out, the session ending, a business switch and another person's sign-in each
// change the owner's key. The panel closes before anything draws under the new
// owner, and every kept draft but the new owner's own leaves the tab's storage.
// A reload changes no owner, so a person's draft outlives it, and so does
// the task open in the panel (S1, `aa-task-open`): it is kept in the tab's
// storage under its owner and opened again on the next load.
//
// **Filed from the page (DN-02, DOCK T-17).** `file` opens a draft with the
// page's guesses; a draft already kept for the person comes back as left.
//
// The panel's place (the seat line, float, sheet, back and forward) and its
// one close are the dock's (MP-3-1, `dock/task-dock.ts`); this host names the
// task, counts its changes and closes it when the dock's X asks. While the
// draft's Create is out the close waits (A11-1): it closes nothing and says
// so, and the dock keeps the panel.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskPanelHost } from '../../screen-registry.tsx';
import { dropOtherDrafts } from './task-draft.ts';
import { prefillOf, type PageContext } from './task-prefill.ts';
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
  /** Closes the panel; false, closing nothing, while the draft's Create is out. */
  readonly close: () => boolean;
  readonly openDraft: (scope: DraftScope) => void;
  /** The open task's stop for this person's running timer, or null when none runs. */
  readonly leaving: (stop: (() => void) | null) => void;
  /** The draft's Create is out: no door opens until the release, which says whether the session held. */
  readonly hold: () => () => boolean;
}

/** Whose panel it is: one person in one business, for one signed-in session. */
export interface PanelOwner {
  /** Business, person and session generation (`grantKeyOf`): each of the four events changes it. */
  readonly key: string;
  /** `business:person`, the owner's draft key, or null when signed out. */
  readonly person: string | null;
  readonly storage: Storage | null;
}

/**
 * The session's end, for the panel: each of `ends` is set to null in the
 * render the owner changes in, before anything draws under the new owner; then
 * every other draft key goes and a Create still out from the old session lands
 * on nothing. `hold` marks the draft's Create in flight (one create, one
 * operation id).
 */
function useOwner(owner: PanelOwner, ...ends: readonly ((none: null) => void)[]) {
  const [heldFor, setHeldFor] = useState(owner.key);
  if (heldFor !== owner.key) {
    setHeldFor(owner.key);
    for (const end of ends) end(null);
  }
  const creating = useRef<object | null>(null);
  const { key, person, storage } = owner;
  useEffect(() => {
    creating.current = null;
    dropOtherDrafts(storage, person);
    dropOtherOpen(storage, person);
  }, [key, person, storage]);
  const hold = useCallback(() => {
    const run = {};
    creating.current = run;
    return (): boolean => {
      const held = creating.current === run;
      if (held) creating.current = null;
      return held;
    };
  }, []);
  return { creating, hold };
}

const OPEN = 'ops-astro.task-open.';

/** The task the person had open in the panel before a reload, or null. */
function readOpen(storage: Storage | null, person: string | null): PanelOpening | null {
  try {
    const held = person === null ? null : (storage?.getItem(`${OPEN}${person}`) ?? null);
    const parsed = held === null ? null : (JSON.parse(held) as Partial<PanelOpening>);
    if (typeof parsed?.taskKey !== 'string' || typeof parsed.door !== 'string') return null;
    return { taskKey: parsed.taskKey, door: parsed.door, tab: parsed.tab ?? null };
  } catch {
    return null;
  }
}

function keepOpen(storage: Storage | null, person: string | null, at: PanelOpening | null): void {
  try {
    if (person === null) return;
    if (at === null) storage?.removeItem(`${OPEN}${person}`);
    else storage?.setItem(`${OPEN}${person}`, JSON.stringify(at));
  } catch {
    // A blocked store keeps the open task only until the reload.
  }
}

/** Remove every kept open task but `person`'s own, unread. */
function dropOtherOpen(storage: Storage | null, person: string | null): void {
  try {
    if (storage === null) return;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key?.startsWith(OPEN) === true && key !== `${OPEN}${person ?? ''}`) {
        storage.removeItem(key);
      }
    }
  } catch {
    // A blocked store kept nothing.
  }
}

/** A draft's scope filed from the page or a door, with the page's guesses (DN-02). */
export function scopeOf(page: PageContext): DraftScope {
  const prefill = prefillOf(page, new Date());
  return { clientId: prefill.clientId, from: page.from, prefill };
}

/** The panel's open task, kept for its owner across a reload; the session's end clears it with the panel. */
function useKeptOpening(owner: PanelOwner) {
  const { storage, person } = owner;
  const [opening, setOpening] = useState<PanelOpening | null>(() => readOpen(storage, person));
  useEffect(() => {
    keepOpen(storage, person, opening);
  }, [storage, person, opening]);
  return [opening, setOpening] as const;
}

export function useTaskPanel(owner: PanelOwner): TaskPanelState {
  const [opening, setOpening] = useKeptOpening(owner);
  const [draft, setDraft] = useState<DraftScope | null>(null);
  const { creating, hold } = useOwner(owner, setOpening, setDraft);
  const [changes, setChanges] = useState(0);
  // Leaving the task (X, Escape, another task, a draft) stops its running
  // timer through MP-4-6's one stop-and-log step, once.
  const stop = useRef<(() => void) | null>(null);
  const leave = useCallback((): void => {
    const pending = stop.current;
    stop.current = null;
    pending?.();
  }, []);
  const open = useCallback(
    (taskKey: string, door: PanelDoor, tab?: ConversationTab) => {
      if (creating.current !== null) return;
      if (taskKey !== opening?.taskKey) leave();
      setDraft(null);
      setOpening({ taskKey, door, tab: tab ?? null });
    },
    [opening, leave, creating],
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
  const close = useCallback((): boolean => {
    if (creating.current !== null) return false;
    leave();
    const door = opening?.door;
    setOpening(null);
    setDraft(null);
    if (door !== undefined) {
      document.querySelector<HTMLElement>(`main [data-panel-door="${door}"]`)?.focus();
    }
    return true;
  }, [opening, leave, creating]);
  const host = useMemo(() => ({ open, changes }), [open, changes]);
  return { host, opening, draft, changed, close, openDraft, leaving, hold };
}

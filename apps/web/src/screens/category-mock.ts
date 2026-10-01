// SPDX-License-Identifier: AGPL-3.0-only
//
// MOCK SEAM: the Projects board's task categories (MP-5-12, P-13).
//
// No task category is stored yet: SL08 builds the task category catalogue
// and `task.set_category` (ORCH47 (b)4). Until then the board's category
// chips draw from this one function, with made-up names, and the screen marks
// them with the design system's mock label (DS-PRIM-32). SL08's catalogue
// replaces this file: `categoryOf` then reads the task's stored category and
// `CATEGORIES_ARE_MOCK` goes. Nothing here is sent to or read from the server.

import type { BoardTask } from '../../../../packages/core-wire/src/index.ts';

/** True while the categories below are made up; the chips then carry the mock label. */
export const CATEGORIES_ARE_MOCK = true;

const MADE_UP = ['Ads', 'Content', 'Website'] as const;

/** A made-up category for a task, the same one on every load (by its key's digits). */
export function categoryOf(task: Pick<BoardTask, 'key'>): string | null {
  const digits = Number(/\d+/u.exec(task.key)?.[0] ?? Number.NaN);
  if (!Number.isFinite(digits)) return null;
  return MADE_UP[digits % MADE_UP.length] ?? null;
}

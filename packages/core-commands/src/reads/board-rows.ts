// SPDX-License-Identifier: AGPL-3.0-only
//
// A page of `task.board`'s rows at a level (API-3).

import type { CommandRefusal } from '../commands/refusal.ts';
import { pageOf, type Paging } from './detail.ts';
import type { boardOf } from './board-admission.ts';

/** One page of the board's rows when the body asks for a level, size or page; else none. */
export function boardPage(
  tasks: Awaited<ReturnType<typeof boardOf>>['tasks'],
  paging: Paging,
):
  | CommandRefusal
  | {
      readonly ok: true;
      readonly page: readonly Readonly<Record<string, unknown>>[];
      readonly next: string | null;
    }
  | undefined {
  if (Object.keys(paging).length === 0) return undefined;
  const page = pageOf(tasks, paging);
  return 'refused' in page ? page : { ok: true, page: page.items, next: page.next };
}

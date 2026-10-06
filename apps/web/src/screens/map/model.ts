// SPDX-License-Identifier: AGPL-3.0-only
//
// What the map's four views share (WF-4): the view names, the writes the page
// sends, the filters and the rule a ticket passes them by.

export type MapViewName = 'map' | 'tickets' | 'frontier' | 'fog';
export type MapCommand = 'map.revise' | 'map.graduate' | 'task.set_blocking';

/**
 * One write: its command, its target and that target's revision, its operands,
 * and the draft slot it was typed in, dropped once applied and kept otherwise.
 */
export type Send = (
  command: MapCommand,
  recordId: string,
  revision: number,
  body: Readonly<Record<string, unknown>>,
  slot?: string,
) => void;

/** One line of the graduate form: a ticket's title and type. */
export interface Line {
  readonly title: string;
  readonly type: string;
}

/**
 * What the person has typed and not had applied, held above the read as
 * TaskDetail holds its draft: each editor's words by slot (`destination`,
 * `notes`, `fog`, `out-of-scope`), the graduate form, and the slot whose save
 * came back VERSION_STALE, drawn as a conflict beside the kept words.
 */
export interface Drafts {
  readonly text: (slot: string) => string | null;
  readonly setText: (slot: string, text: string | null) => void;
  readonly graduating: { readonly patch: string; readonly lines: readonly Line[] } | null;
  readonly setGraduating: (form: Drafts['graduating']) => void;
  readonly conflict: string | null;
}

/** What the tickets and frontier views are narrowed to. Empty is everything. */
export interface Filters {
  readonly type: string;
  readonly text: string;
}

export const NO_FILTERS: Filters = { type: '', text: '' };

/** The ticket types a map's tickets take (WF-1). */
export const TICKET_TYPES = ['research', 'task', 'build', 'grilling', 'prototype'] as const;

/** Whether a ticket passes the filters: its type, and its key or title containing the text. */
export function passes(
  filters: Filters,
  ticket: { readonly type?: string; readonly key?: string | null; readonly title?: string | null },
): boolean {
  if (filters.type !== '' && ticket.type !== filters.type) return false;
  const text = filters.text.trim().toLowerCase();
  if (text === '') return true;
  return `${ticket.key ?? ''} ${ticket.title ?? ''}`.toLowerCase().includes(text);
}

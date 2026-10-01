// SPDX-License-Identifier: AGPL-3.0-only
//
// What the map's four views share (WF-4): the view names, the writes the page
// sends, the filters and the rule a ticket passes them by.

export type MapViewName = 'map' | 'tickets' | 'frontier' | 'fog';
export type MapCommand = 'map.revise' | 'map.graduate' | 'task.set_blocking';

/** One write: its command, its target and that target's revision, and its operands. */
export type Send = (
  command: MapCommand,
  recordId: string,
  revision: number,
  body: Readonly<Record<string, unknown>>,
) => void;

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

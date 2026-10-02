// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the one ask seam, by register row (CS-7.37).
//
// An entry point is a sparkle on a host page: its register row, the widget it
// sits on, and the client the host has in scope. `entryFor` makes the ask the
// drawer opens with: the scope, the drafted question and the cited widget (the
// subject follows from the scope, `subjectFor`). Each host page's own ticket
// places its sparkle; this is the one place that says what a row asks.
//
// **AG-K7 sits on agency-wide pages**, which never talk about one client: it
// drafts the row's own question with no client in scope, and a client handed to
// it opens nothing rather than being dropped, so a row about one client cannot
// reach a cloud model as page talk. Every other row is about one client and
// opens nothing without one; its client's material then waits on a local model
// in the drawer (`modelOffer`).
//
// A row's own question (the mockup's `data-ask`) is drafted when it has one;
// otherwise the row's group drafts it from the widget and the client. Nothing
// is sent until the person sends it.

import type { AskEntry } from './chats.ts';

export interface EntryPoint {
  /** The register row the sparkle is (AG-K7, CL-M03 and the rest). */
  readonly row: string;
  readonly widget: { readonly id: string; readonly label: string };
  /** The client the host page has in scope, if any. */
  readonly client: { readonly id: string; readonly name: string } | null;
  /** The row's own question, drafted in place of the group's. */
  readonly question?: string;
}

type Draft = (widget: string, client: string) => string;

const behind: Draft = (widget, client) => `What is behind ${widget} for ${client}?`;

/** Each client group's drafted question, in the register's words for it. */
const GROUPS = {
  figure: behind,
  'move-or-run': (widget, client) =>
    `What should I know about this move or the run, ${widget}, for ${client}?`,
  move: (widget, client) => `What is behind this move, ${widget}, for ${client}?`,
  'running-test': (widget, client) => `How is the running test, ${widget}, going for ${client}?`,
  stage: (widget, client) => `What is happening at the ${widget} stage for ${client}?`,
  revenue: (widget, client) =>
    `Where does the attributed revenue in ${widget} come from for ${client}?`,
  'site-speed': (widget, client) => `What is behind the site speed in ${widget} for ${client}?`,
} as const satisfies Record<string, Draft>;

type Group = keyof typeof GROUPS | 'agency';

/** Every entry row the ticket names, and its group. */
export const ENTRY_ROWS: Readonly<Record<string, Group>> = Object.freeze({
  'AG-K7': 'agency',
  'SI-M03': 'figure',
  'SIR-M03': 'figure',
  'GA-M06': 'move-or-run',
  'MA-M06': 'move',
  'TS-M05': 'running-test',
  'LR-M03': 'figure',
  'CL-M03': 'figure',
  // The client-and-metric group: scoped to this client and metric.
  'WSH-11': 'figure',
  'WSH-13': 'figure',
  'TL-W01': 'figure',
  'FM-W01': 'figure',
  'SS-W01': 'figure',
  'TL-M03': 'figure',
  'SS-M03': 'figure',
  'SS3-M03': 'figure',
  'FM-M03': 'figure',
  'OB-M06': 'figure',
  'EM-M03': 'figure',
  'FN-M03': 'stage',
  'RV-M03': 'revenue',
  'WP-M03': 'site-speed',
  'WPO-M03': 'site-speed',
});

const said = (text: string | undefined): string => text?.trim() ?? '';

export function entryFor(point: EntryPoint): AskEntry | null {
  if (!Object.hasOwn(ENTRY_ROWS, point.row)) return null;
  const group = ENTRY_ROWS[point.row];
  const label = said(point.widget.label);
  if (group === undefined || point.widget.id === '' || label === '') return null;
  const widget = { id: point.widget.id, label };
  const own = said(point.question);
  if (group === 'agency') {
    if (point.client !== null || own === '') return null;
    return { row: point.row, widget, question: own, scope: { client: null, task: null } };
  }
  const { client } = point;
  if (client === null || client.id === '' || said(client.name) === '') return null;
  return {
    row: point.row,
    widget,
    question: own === '' ? GROUPS[group](label, said(client.name)) : own,
    scope: { client, task: null },
  };
}

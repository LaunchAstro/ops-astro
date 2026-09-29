// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the Notifications panel's model, before its tests pass.

export interface InboxItem {
  readonly id: string;
  readonly reason:
    | 'decision'
    | 'waiting_run'
    | 'run_finished'
    | 'assignment'
    | 'mention'
    | 'incident'
    | 'client_comment';
  readonly workState: 'open' | 'cleared' | 'withdrawn';
  readonly access: 'readable' | 'withheld' | 'gone';
  readonly owed: boolean;
  readonly counted: boolean;
  readonly raisedAt: string;
  readonly closedAt: string | null;
  readonly task?: { readonly key: string; readonly title: string | null } | undefined;
}

export interface InboxGroupRef {
  readonly key: string;
  readonly name: string;
  readonly href?: string | undefined;
}

export type InboxTab = 'owed' | 'info';
export type InboxBand = 'owe' | 'fyi' | 'done';

export interface InboxGroup {
  readonly ref: InboxGroupRef;
  readonly items: readonly InboxItem[];
  readonly owe: number;
  readonly last: string;
}

export function groupsOf(
  _items: readonly InboxItem[],
  _tab: InboxTab | undefined,
  _groupOf: (item: InboxItem) => InboxGroupRef,
): readonly InboxGroup[] {
  return [];
}

export function bandHeads(_groups: readonly InboxGroup[]): boolean {
  return false;
}

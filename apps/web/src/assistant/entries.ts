// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the one ask seam, by register row (CS-7.37). Declared shape only.

import type { AskEntry } from './chats.ts';

export interface EntryPoint {
  readonly row: string;
  readonly widget: { readonly id: string; readonly label: string };
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly question?: string;
}

export const ENTRY_ROWS: Readonly<Record<string, string>> = {};

export function entryFor(_point: EntryPoint): AskEntry | null {
  return null;
}

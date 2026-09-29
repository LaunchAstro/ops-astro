// SPDX-License-Identifier: AGPL-3.0-only
//
// The width-and-theme check report (MP-1-7). Not built yet.

import type { Packet } from './packet.ts';

export type PageShot = { page: string; width: number; picture: string | null; overflow: number };

export const DARK_PENDING = 'not built';

export function builtPages(): string[] {
  throw new Error('MP-1-7: not built');
}

export function overflowOf(_metrics: { scrollWidth: number; clientWidth: number }): number {
  throw new Error('MP-1-7: not built');
}

export function report(
  _packet: Packet,
  _pages: readonly string[],
  _shots: readonly PageShot[],
): { lines: string[]; failed: number } {
  throw new Error('MP-1-7: not built');
}

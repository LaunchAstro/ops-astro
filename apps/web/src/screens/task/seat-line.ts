// SPDX-License-Identifier: AGPL-3.0-only
import type { FrameFacts } from './frame-seam.ts';

export type Placement = 'seated' | 'floating' | 'sheet' | 'bottom-sheet';

export function seatFor(_facts: FrameFacts): {
  readonly placement: Placement;
  readonly width: number;
} {
  return { placement: 'floating', width: 0 };
}

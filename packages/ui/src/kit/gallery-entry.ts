// SPDX-License-Identifier: AGPL-3.0-only
//
// One entry on the component gallery (MP-1-3): a catalogue id and the states
// it is drawn in.

import type { ReactElement } from 'react';

export interface GalleryState {
  readonly label: string;
  readonly render: () => ReactElement;
}

export interface GalleryEntry {
  /** A catalogue id, or the ticket for a treatment the catalogue has no single id for. */
  readonly id: `DS-PRIM-${number}` | `DS-COMP-${number}` | 'DOCK-D26' | 'MP-1-6';
  readonly name: string;
  /** Whether the harness hovers and focuses it. */
  readonly interactive: boolean;
  readonly states: readonly GalleryState[];
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3 stub, replaced by the change that follows the red tests.

import type { ReactElement } from 'react';

export interface GalleryState {
  readonly label: string;
  readonly render: () => ReactElement;
}

export interface GalleryEntry {
  readonly id: `DS-PRIM-${number}` | `DS-COMP-${number}` | `DOCK-D26`;
  readonly name: string;
  readonly interactive: boolean;
  readonly states: readonly GalleryState[];
}

export const GALLERY: readonly GalleryEntry[] = [];

export function Gallery(): ReactElement {
  return <div className="gallery" />;
}

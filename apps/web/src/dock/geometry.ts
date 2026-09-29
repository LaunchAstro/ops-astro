// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-2 stub, replaced by the change that follows the red tests.

import type { PanelId } from '../panels.ts';

export const PANEL_DEFAULT = 550;
export const PANEL_FLOOR = 380;
export const CONTENT_FLOOR = 836;

export interface DockGeometry {
  readonly mode: 'rest' | 'seated' | 'floating' | 'sheet';
  readonly open: readonly PanelId[];
  readonly closes: PanelId | null;
  readonly panelWidth: number;
  readonly groupWidth: number;
  readonly groupLeft: number;
  readonly content: number;
}

export const dockGeometry = (input: {
  readonly viewport: number;
  readonly navRail: number;
  readonly width: number;
  readonly open: readonly PanelId[];
}): DockGeometry => ({
  mode: 'rest',
  open: input.open,
  closes: null,
  panelWidth: 0,
  groupWidth: 0,
  groupLeft: 0,
  content: 0,
});

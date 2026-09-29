// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-5 stub, replaced by the change that follows the red tests.

import type { PanelId } from '../panels.ts';
import type { DockState } from './open-set.ts';

export const HISTORY_CAP = 25;

export interface DockEntry extends DockState {
  readonly scroll: { readonly [Id in PanelId]?: number };
}

export interface DockHistory {
  readonly entries: readonly DockEntry[];
  readonly at: number;
}

export const start = (state: DockState): DockHistory => ({
  entries: [{ ...state, scroll: {} }],
  at: 0,
});
export const record = (history: DockHistory, _state: DockState): DockHistory => history;
export const seal = (history: DockHistory, _id: PanelId, _top: number): DockHistory => history;
export const back = (history: DockHistory): DockHistory => history;
export const forward = (history: DockHistory): DockHistory => history;
export const canBack = (_history: DockHistory): boolean => false;
export const canForward = (_history: DockHistory): boolean => false;

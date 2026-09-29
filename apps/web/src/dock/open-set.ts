// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1 stub, replaced by the change that follows the red tests.

import type { PanelId } from '../panels.ts';
import type { Session, StorageLike } from '../session/token.ts';

export interface DockState {
  readonly open: readonly PanelId[];
  readonly places: { readonly [Id in PanelId]?: string };
}

export const CLOSED: DockState = { open: [], places: {} };

export const ranked = (state: DockState): readonly PanelId[] => state.open;
export const press = (state: DockState, _id: PanelId, _shift: boolean): DockState => state;
export const openByGesture = (
  state: DockState,
  _id: PanelId,
  _shift: boolean,
  _place?: string,
): DockState => state;
export const close = (state: DockState, _id: PanelId): DockState => state;
export const closeAll = (state: DockState): DockState => state;
export const escape = (state: DockState): DockState => state;
export const closedBy = (_before: DockState, _after: DockState): readonly PanelId[] => [];
export const handledInside = (_event: KeyboardEvent): boolean => false;

export interface DockSlot {
  readonly read: () => DockState;
  readonly write: (state: DockState) => void;
}
export const dockSlot = (_storage: StorageLike | null, _session: Session | null): DockSlot => ({
  read: () => CLOSED,
  write: () => undefined,
});

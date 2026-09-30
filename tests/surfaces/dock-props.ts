// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock as a shell test hands it when only its tabs matter: no panel open
// and every press heard by nobody.

import type { DockProps, DockTab } from '../../packages/ui/src/surfaces/Dock.tsx';

const nobody = (): void => {};

export const dockOf = (tabs: readonly Omit<DockTab, 'count'>[]): DockProps => ({
  tabs: tabs.map((tab) => ({ ...tab, count: null })),
  panels: [],
  onTab: nobody,
  onClose: nobody,
  onCloseAll: nobody,
  onBack: nobody,
  onForward: nobody,
  onDoor: nobody,
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent drawer (MP-7-11) as the dock's own `ai` panel. It has no address
// of its own, so it has no registration in `PANELS`: the dock draws its tab and
// its body itself, as it draws the task panel's (`task-dock.ts`). The tab is
// there whenever the drawer can be drawn, first in the rank; the panel is open
// while `ai` is in the open set, so the gesture law, Close all, Escape and the
// phone's one panel treat it like any other. Storage and the history never
// bring it back after a reload: the dock restores only registered panels.

import type { ReactNode } from 'react';
import type { DockPanel, DockTab } from '@launchastro/ui';
import { PANEL_RANK, type PanelId } from '../panels.ts';
import { pathTo } from '../routes.ts';
import { close } from './open-set.ts';
import type { DockModel } from './use-dock.ts';

const LABEL = 'Agent';

const rank = (id: string): number => PANEL_RANK.indexOf(id as PanelId);

/** The rail's tabs, with the Agent tab in its rank wherever the drawer can be drawn. */
export function withAgentTab(
  tabs: readonly DockTab[],
  agent: ReactNode | null,
  open: boolean,
): readonly DockTab[] {
  if (agent === null) return tabs;
  const mine: DockTab = { id: 'ai', label: LABEL, icon: 'sparkles', count: null, open };
  return [...tabs, mine].toSorted((a, b) => rank(a.id) - rank(b.id));
}

/** The Agent panel: the dock's head over the drawer. Its door is the board's: it has no page. */
export const agentPanelOf = (
  body: ReactNode,
  walked: Pick<DockPanel, 'canBack' | 'canForward' | 'scrollTop'>,
): DockPanel => ({
  id: 'ai',
  label: LABEL,
  ariaLabel: 'Agent: ask about the page you are on',
  door: pathTo('agency:projects-board'),
  icon: 'sparkles',
  ...walked,
  body,
});

/** The drawer's own close takes `ai` out of the dock. */
export function closeAgent(dock: DockModel): void {
  dock.change((state) => close(state, 'ai'));
}

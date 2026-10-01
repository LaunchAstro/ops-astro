// SPDX-License-Identifier: AGPL-3.0-only
//
// THE PANEL REGISTRY. A panel is not a route, which is why it is a second
// registry rather than a row in the first: a panel is reachable from every page
// while a route is reachable from one address, and folding the two into one
// list would lose that distinction.
//
// **The identifier is frozen and the label is not.** The pinned estate's own
// rule: labels rename freely, identifiers never, because the stored open-set,
// the rail's declared order and the body class all cite the identifier.
//
// Registration is eager and must stay eager. A lazy registration would mean the
// seams a panel publishes do not exist until somebody opens it — a defect no
// gate would catch, because opening the panel is the act that would make the
// seam appear.
//
// Notifications, Settings and Team are navigation entries rather than drawers:
// `route` names the route that draws the surface, and the dock tab goes there. `ai`
// is a drawer (MP-7-11): it has no address of its own, `route` is null, and the
// tab opens it over the page, carrying that page's standing scope only. Its
// surface reads AW-03's conversation records.
//
// **A registration with a route the router does not serve is the failure this
// registry has to avoid.** `route` is a `StaticRouteId`, so a registration can
// only name a route `routes.ts` serves at an address with no parameters, and
// the tab has somewhere to arrive.

import type { GlyphName } from '@launchastro/ui';
import { pathTo, type StaticRouteId } from './routes.ts';

export interface PanelRegistration {
  /** Frozen. The label above it is not. */
  readonly id: string;
  readonly label: string;
  /** Announced on the panel element itself. */
  readonly ariaLabel: string;
  /** The route that draws the same surface at an address of its own, if any. */
  readonly route: StaticRouteId | null;
  /** The dock tab's glyph, the one the mockup registers for this panel. */
  readonly icon: GlyphName;
}

export const PANELS: readonly PanelRegistration[] = [
  {
    id: 'notifications',
    label: 'Notifications',
    ariaLabel: 'Notifications: what is waiting on you',
    route: 'agency:inbox',
    icon: 'bell',
  },
  {
    id: 'settings',
    label: 'Settings',
    ariaLabel: 'Business settings',
    route: 'agency:settings',
    icon: 'settings-sliders',
  },
  {
    id: 'team',
    label: 'Team',
    ariaLabel: 'Team: who is here and who is away',
    route: 'agency:team',
    icon: 'comments',
  },
  {
    id: 'ai',
    label: 'Agent',
    ariaLabel: 'Agent',
    route: null,
    icon: 'sparkles',
  },
];

/**
 * The dock's tabs at `here`. The panel registry is the dock. A registration
 * with a route names the address that draws its surface, and the tab navigates
 * there rather than opening a drawer over the page: the surface has a real
 * address, and an address a person can quote is worth more than a panel they
 * cannot. The Agent drawer (MP-7-11) has no address: its tab is open while the
 * drawer is. The client face has no dock (R17).
 */
export const dockTabs = (
  here: string,
  counts: Readonly<Record<string, number | null>> = {},
  agentOpen = false,
): { id: string; label: string; icon: GlyphName; open: boolean; count?: number }[] =>
  PANELS.map((panel) => {
    const tab: { id: string; label: string; icon: GlyphName; open: boolean; count?: number } = {
      id: panel.id,
      label: panel.label,
      icon: panel.icon,
      open: panel.route === null ? agentOpen : here === pathTo(panel.route),
    };
    const count = counts[panel.id] ?? null;
    if (count !== null) tab.count = count;
    return tab;
  });

/**
 * Where a dock tab goes: the Agent drawer toggles over the page; a routed
 * panel opens its address, or the board when it is already there.
 */
export function dockTarget(id: string, here: string): 'agent' | string | null {
  const panel = PANELS.find((entry) => entry.id === id);
  if (panel === undefined) return null;
  if (panel.route === null) return 'agent';
  const target = pathTo(panel.route);
  return here === target ? pathTo('agency:projects-board') : target;
}

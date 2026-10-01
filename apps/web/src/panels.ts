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
// The working slice registers one panel, `settings`, and it is a navigation
// entry rather than a drawer: `route` names the route that draws the surface,
// and the dock tab goes there. There is no `ai` panel: its surface reads
// conversation records this build does not store, and a dock tab that opens
// onto nothing is worse than no tab at all.
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
    id: 'todos',
    label: 'Projects',
    ariaLabel: 'My to-dos',
    route: 'agency:todos',
    icon: 'briefcase',
  },
  {
    id: 'team',
    label: 'Team',
    ariaLabel: 'Team: who is here and who is away',
    route: 'agency:team',
    icon: 'comments',
  },
];

/**
 * The dock's tabs at `here`. The panel registry is the dock. Each registration
 * names the address that draws its surface, and the tab navigates there rather
 * than opening a drawer over the page: the surface has a real address, and an
 * address a person can quote is worth more than a panel they cannot. The
 * client face has no dock (R17).
 */
export const dockTabs = (
  here: string,
): { id: string; label: string; icon: GlyphName; open: boolean }[] =>
  PANELS.map((panel) => ({
    id: panel.id,
    label: panel.label,
    icon: panel.icon,
    open: panel.route !== null && here === pathTo(panel.route),
  }));

/**
 * What pressing a dock tab at `here` does: go to its panel's address. An open
 * tab is announced as "Close", so pressing it leaves the address for the board
 * rather than pushing the same address again.
 */
export const dockTabGo =
  (here: string, navigate: (path: string) => void) =>
  (id: string): void => {
    const panel = PANELS.find((entry) => entry.id === id);
    if (panel === undefined || panel.route === null) return;
    const target = pathTo(panel.route);
    navigate(here === target ? pathTo('agency:projects-board') : target);
  };

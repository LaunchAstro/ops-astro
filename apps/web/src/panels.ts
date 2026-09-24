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
// and the dock tab goes there. The draft registers a second, `ai`, whose
// surface reads conversation records this build does not store; that one stays
// unregistered, because a dock tab that opens onto nothing is worse than no
// tab at all.
//
// **A registration with a route the router does not serve is the failure this
// registry has to avoid.** `route` is a `StaticRouteId`, so a registration can
// only name a route `routes.ts` serves at an address with no parameters, and
// the tab has somewhere to arrive.

import type { StaticRouteId } from './routes.ts';

export interface PanelRegistration {
  /** Frozen. The label above it is not. */
  readonly id: string;
  readonly label: string;
  /** Announced on the panel element itself. */
  readonly ariaLabel: string;
  /** The route that draws the same surface at an address of its own, if any. */
  readonly route: StaticRouteId | null;
}

export const PANELS: readonly PanelRegistration[] = [
  {
    id: 'settings',
    label: 'Settings',
    ariaLabel: 'Business settings',
    route: 'agency:settings',
  },
];

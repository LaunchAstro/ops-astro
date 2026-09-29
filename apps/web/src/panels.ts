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
// **The rail's order is one declared list, and nothing else orders it.** A
// registration is keyed by its id and carries no rank, so the order it was
// written in cannot leak onto the rail. The list is DR-59's, top to bottom,
// with the mockup's ids (`dock.js` `ORDER` runs bottom to top), and the working
// slice's `settings` after it.
//
// **Only a panel with a body gets a tab (R34).** `route` is required and is a
// `StaticRouteId`, so a registration names a route `routes.ts` serves at an
// address with no parameters, and the tab has somewhere to arrive. The route
// must also need a session: an authenticated route has a screen that reads the
// business's records, and a public one such as sign-in reads none, so a
// registration pointing there draws no tab. The draft's
// `ai` panel reads conversation records this build does not store, so it has
// an id and a rank and no registration; the rail grows as the stores land.
//
// **A count chip is derived as the tab is built**, from the count its store
// reports, so it paints at load rather than after the first open (D-18), and
// is printed whole: 120 reads "120", never "99+". No count, or zero, no chip.

import { ROUTES, type StaticRouteId } from './routes.ts';

export const PANEL_RANK = Object.freeze([
  'ai',
  'notifs',
  'team',
  'clients',
  'todos',
  'task',
  'marks',
  'notes',
  'settings',
] as const);

export type PanelId = (typeof PANEL_RANK)[number];

export interface PanelRegistration {
  readonly label: string;
  /** Announced on the panel element itself. */
  readonly ariaLabel: string;
  /** The route that draws the panel's surface at an address of its own. */
  readonly route: StaticRouteId;
  /** The tenant's own close. */
  readonly onClose?: () => void;
}

export type PanelRegistry = { readonly [Id in PanelId]?: PanelRegistration };

export interface PanelTab {
  readonly id: PanelId;
  readonly label: string;
  readonly route: StaticRouteId;
  /** The chip's text, or null when there is nothing to count. */
  readonly count: string | null;
}

export const PANELS: PanelRegistry = {
  settings: {
    label: 'Settings',
    ariaLabel: 'Business settings',
    route: 'agency:settings',
  },
};

const IDS: ReadonlySet<string> = new Set(PANEL_RANK);

/** Parses an id arriving from outside the type system, such as a stored open set. */
export function isPanelId(value: string): value is PanelId {
  return IDS.has(value);
}

export function dockTabs(
  counts: { readonly [Id in PanelId]?: number } = {},
  registry: PanelRegistry = PANELS,
): readonly PanelTab[] {
  return PANEL_RANK.flatMap((id) => {
    const panel = registry[id];
    if (panel === undefined || !ROUTES[panel.route].authenticated) return [];
    const count = counts[id] ?? 0;
    return [
      { id, label: panel.label, route: panel.route, count: count > 0 ? String(count) : null },
    ];
  });
}

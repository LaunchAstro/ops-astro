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
// The working slice registers no panel. The draft registers one, `ai`, whose
// surface reads conversation records this build does not store; `route` stays
// in the shape for it, and this list is empty rather than carrying a dock tab
// that opens onto nothing.

export interface PanelRegistration {
  /** Frozen. The label above it is not. */
  readonly id: string;
  readonly label: string;
  /** Announced on the panel element itself. */
  readonly ariaLabel: string;
  /** The route that draws the same surface at an address of its own, if any. */
  readonly route: string | null;
}

export const PANELS: readonly PanelRegistration[] = [];

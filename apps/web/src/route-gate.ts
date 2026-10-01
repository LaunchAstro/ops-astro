// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in gate over the route registry, split out of `routes.ts` when the main merge joined
// it past the 300-line limit.

import type { AuthenticatedRouteId, OpenRouteId, RouteMatch } from './routes.ts';

/** Which screen an address draws, given whether there is a session. */
export type Gate =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'enrol'; readonly token: string }
  | { readonly kind: 'signed-in-already' }
  | { readonly kind: 'open'; readonly match: RouteMatch<OpenRouteId> }
  | { readonly kind: 'screen'; readonly match: RouteMatch<AuthenticatedRouteId> };

/**
 * The sign-in gate. An address that needs a session and has none is the
 * sign-in screen, and the sign-in screen is where a signed-out person lands.
 * Neither is an error. An open route asks nothing of the session.
 */
export function gateOf(match: RouteMatch | null, signedIn: boolean): Gate {
  if (match === null) return { kind: 'not-found' };
  // The enrolment page needs no session and is the same with one.
  if (match.id === 'agency:enrol') return { kind: 'enrol', token: match.params.token };
  if (isOpen(match)) return { kind: 'open', match };
  if (!signedIn) return { kind: 'sign-in' };
  if (!needsSession(match)) return { kind: 'signed-in-already' };
  return { kind: 'screen', match };
}

function needsSession(match: RouteMatch): match is RouteMatch<AuthenticatedRouteId> {
  return match.route.authenticated;
}

function isOpen(match: RouteMatch): match is RouteMatch<OpenRouteId> {
  return !match.route.authenticated && match.id !== 'agency:sign-in' && match.id !== 'agency:enrol';
}

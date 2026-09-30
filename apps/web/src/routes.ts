// SPDX-License-Identifier: AGPL-3.0-only
//
// THE ROUTE REGISTRY, and the reason it exists as a list rather than as JSX.
//
// The single most important screen in the slice — the task detail page — is
// drawn in the pinned mockup and **absent from its route census**: the address
// appears only as a Hub detail family, and a capability map built by walking
// the route file would not find it (specification 13.3). So the slice registers
// it explicitly, and this is the registration.
//
// The router consumes this list. That pairing is what makes a discovery check
// independent: if this were a list only a check read, it would be a second copy
// of the map wearing different clothes. A route added to the application is
// added here, because otherwise it does not resolve.
//
// **Identifiers are namespace-qualified.** Sixteen bare identifiers are reused
// across namespaces in the existing corpus — `projects`, `reviews`, `details`
// and thirteen more — and a registry keyed on the bare identifier would either
// report sixteen duplicates that are not duplicates or silently collapse the
// agency and portal pairs into one entry.
//
// The working slice registers the four addresses it serves. `/agent/` is not
// one: that surface draws records no part of this build stores, and a route
// that resolves to nothing is a worse answer than an address that does not
// resolve.

/** `agency` is the Hub; `clients` and `portal` are one client's two faces. */
export type Namespace = 'agency' | 'clients' | 'portal';

/**
 * One registered address. Its id is the key it is registered under,
 * `<namespace>:<name>`, and immutable once published. `authenticated` says
 * whether a signed-in session is required to draw it, and it decides which
 * kind of identifier the route carries, so a screen lookup keyed by
 * `AuthenticatedRouteId` can only be reached by a route that needs a session.
 */
export interface RouteDescriptor {
  readonly namespace: Namespace;
  /** The canonical address. `:name` marks a parameter. */
  readonly path: string;
  readonly title: string;
  /** Which pinned surface this route draws, or `none` for one that draws none. */
  readonly surface: 'S1' | 'S2' | 'none';
  readonly authenticated: boolean;
}

export const ROUTES = {
  'agency:sign-in': {
    namespace: 'agency',
    path: '/sign-in',
    title: 'Sign in',
    surface: 'none',
    authenticated: false,
  },
  // A business's published legal documents (C81, CS-16.20): the client terms,
  // the privacy policy and the data-handling statement, each at an address
  // that needs no sign-in and is linked from sign-in. It draws the public read
  // alone, signed in or not; the breach runbook is the operators' own and has
  // no public address.
  'agency:legal': {
    namespace: 'agency',
    path: '/legal/:business/:document/',
    title: 'Legal',
    surface: 'none',
    authenticated: false,
  },
  'agency:projects-board': {
    namespace: 'agency',
    path: '/projects/',
    title: 'Projects',
    surface: 'S1',
    authenticated: true,
  },
  // The one specification 13.3 requires be registered explicitly. Note the
  // address: the pinned mockup reaches this page as `/agency/task/?task=<id>`,
  // a query parameter, and the path form here is the canonical address the
  // slice adopts (specification 13.1). The surface is a port; the address is
  // not.
  //
  // The parameter is the task's `key`, not its identifier. A person types and
  // quotes a key, and the acceptance case asks for the task's *own address*
  // to survive a hard reload — an address built on an internal identifier
  // survives that too, and is no use to the person reading it out.
  'agency:task-detail': {
    namespace: 'agency',
    path: '/task/:key',
    title: 'Task',
    surface: 'S2',
    authenticated: true,
  },
  // The business's own two operation-classified settings. It draws no pinned
  // surface — the mockup has no settings screen — so `surface` is `none`
  // rather than a letter it would be borrowing. The manifest places it in the
  // Hub rail, and the panel registry carries the same destination for the dock.
  'agency:settings': {
    namespace: 'agency',
    path: '/settings',
    title: 'Settings',
    surface: 'none',
    authenticated: true,
  },
  // Settings ▸ Access (C32, C58), Settings ▸ Telemetry (C34) and Settings ▸
  // Operations (C55): pages of the manifest's Settings section, drawing no
  // pinned surface. Access is who may do what, a grant and ending a person's
  // access; Operations is the operations view behind `operations:read`
  // (CS-14.31); Telemetry is its service-health section (CS-2.16).
  'agency:access': {
    namespace: 'agency',
    path: '/settings/access/',
    title: 'Access',
    surface: 'none',
    authenticated: true,
  },
  'agency:telemetry': {
    namespace: 'agency',
    path: '/settings/telemetry/',
    title: 'Telemetry',
    surface: 'none',
    authenticated: true,
  },
  'agency:operations': {
    namespace: 'agency',
    path: '/settings/operations/',
    title: 'Operations',
    surface: 'none',
    authenticated: true,
  },
  // The component gallery (MP-1-3): every piece of the kit in its states,
  // for the owner's checks and the width-and-theme harness. It draws sample
  // words and no record; it asks for a session like every working page, and
  // the route manifest has no page for it, so it has no rail entry: it is not
  // a place work happens.
  'agency:gallery': {
    namespace: 'agency',
    path: '/gallery/',
    title: 'Component gallery',
    surface: 'none',
    authenticated: true,
  },
} as const satisfies Readonly<Record<`${Namespace}:${string}`, RouteDescriptor>>;

export type RouteId = keyof typeof ROUTES;

type Route<Id extends RouteId> = (typeof ROUTES)[Id];

/** A route a signed-out person may be drawn. */
export type PublicRouteId = {
  [Id in RouteId]: Route<Id>['authenticated'] extends false ? Id : never;
}[RouteId];

/** A public route other than sign-in: drawn the same with a session or without. */
export type OpenRouteId = Exclude<PublicRouteId, 'agency:sign-in'>;

/** A route that needs a session. Each one has a screen in `SCREENS`. */
export type AuthenticatedRouteId = Exclude<RouteId, PublicRouteId>;

/** The `:name` parameters a path declares, read off the path itself. */
type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

/** A route's parameters, decoded: one string for each `:name` in its path. */
export type ParamsOf<Id extends RouteId> = {
  readonly [Name in ParamNames<Route<Id>['path']>]: string;
};

/** A route whose address has no parameters, so it can be linked to bare. */
export type StaticRouteId = {
  [Id in RouteId]: [keyof ParamsOf<Id>] extends [never] ? Id : never;
}[RouteId];

/** A resolved address: the route, its id, and its parameters typed by route. */
export type RouteMatch<Id extends RouteId = RouteId> = {
  [Each in Id]: {
    readonly id: Each;
    readonly route: Route<Each>;
    readonly params: ParamsOf<Each>;
  };
}[Id];

// The registry's own ids. `satisfies` above admits no key the type lacks, so
// the keys read back are exactly `RouteId`.
const IDS = Object.keys(ROUTES) as readonly RouteId[];

/**
 * The matcher. Small on purpose: no router package is named in
 * `docs/platform-construction.md`, and the registry above has to be the thing
 * the application resolves through or a discovery check is reading a
 * decoration.
 */
export function matchRoute(path: string): RouteMatch | null {
  const asked = segments(path);
  for (const id of IDS) {
    const route = ROUTES[id];
    const pattern = segments(route.path);
    if (pattern.length !== asked.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, part] of pattern.entries()) {
      const given = asked[index];
      if (given === undefined) {
        matched = false;
        break;
      }
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(given);
      else if (part !== given) {
        matched = false;
        break;
      }
    }
    // Every `:name` in the pattern was filled from its own segment, which is
    // what `ParamsOf` says the route's parameters are.
    if (matched) return { id, route, params } as RouteMatch;
  }
  return null;
}

/**
 * The address of a registered route, with its parameters filled in.
 *
 * Every link and navigation goes through this rather than typing the path out,
 * so the registry stays the one place an address is spelt. A route with
 * parameters takes them, typed by its path, and one without takes none.
 */
export function pathTo<Id extends RouteId>(
  id: Id,
  ...[params]: [keyof ParamsOf<Id>] extends [never] ? [] : [ParamsOf<Id>]
): string {
  let path: string = ROUTES[id].path;
  for (const [name, value] of Object.entries<string>(params ?? {})) {
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  return path;
}

/** Which screen an address draws, given whether there is a session. */
export type Gate =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'sign-in' }
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
  if (isOpen(match)) return { kind: 'open', match };
  if (!signedIn) return { kind: 'sign-in' };
  if (!needsSession(match)) return { kind: 'signed-in-already' };
  return { kind: 'screen', match };
}

function needsSession(match: RouteMatch): match is RouteMatch<AuthenticatedRouteId> {
  return match.route.authenticated;
}

function isOpen(match: RouteMatch): match is RouteMatch<OpenRouteId> {
  return !match.route.authenticated && match.id !== 'agency:sign-in';
}

const segments = (path: string): readonly string[] => path.split('/').filter((part) => part !== '');

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
// The working slice registers the four addresses it serves. The draft also
// registers `/agent/`; that surface draws records no part of this build stores,
// so it is not registered here — a route that resolves to nothing is a worse
// answer than an address that does not resolve.

export type Namespace = 'agency' | 'portal';

/** A route a signed-out person may be drawn. */
export type PublicRouteId = 'agency:sign-in';

/** A route that needs a session. Each one has a screen in `SCREENS`. */
export type AuthenticatedRouteId =
  'agency:projects-board' | 'agency:task-detail' | 'agency:settings';

export type RouteId = PublicRouteId | AuthenticatedRouteId;

interface RouteBase {
  readonly namespace: Namespace;
  /** The canonical address. `:name` marks a parameter. */
  readonly path: string;
  readonly title: string;
  /** Which pinned surface this route draws, or `none` for one that draws none. */
  readonly surface: 'S1' | 'S2' | 'none';
  /** Whether the rail carries an entry for it. */
  readonly rail: boolean;
}

/**
 * One registered address. `id` is `<namespace>:<name>` and immutable once
 * published. `authenticated` says whether a signed-in session is required to
 * draw it, and it decides which kind of identifier the route carries, so a
 * screen lookup keyed by `AuthenticatedRouteId` can only be reached by a route
 * that needs a session.
 */
export type RouteDescriptor =
  | (RouteBase & { readonly id: PublicRouteId; readonly authenticated: false })
  | (RouteBase & { readonly id: AuthenticatedRouteId; readonly authenticated: true });

export const ROUTES: readonly RouteDescriptor[] = [
  {
    id: 'agency:sign-in',
    namespace: 'agency',
    path: '/sign-in',
    title: 'Sign in',
    surface: 'none',
    rail: false,
    authenticated: false,
  },
  {
    id: 'agency:projects-board',
    namespace: 'agency',
    path: '/projects/',
    title: 'Projects',
    surface: 'S1',
    rail: true,
    authenticated: true,
  },
  {
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
    id: 'agency:task-detail',
    namespace: 'agency',
    path: '/task/:key',
    title: 'Task',
    surface: 'S2',
    rail: false,
    authenticated: true,
  },
  {
    // The business's own two operation-classified settings. It draws no pinned
    // surface — the mockup has no settings screen — so `surface` is `none`
    // rather than a letter it would be borrowing. It carries a rail entry
    // because it is a place a person goes to deliberately, and the panel
    // registry carries the same destination for the dock.
    id: 'agency:settings',
    namespace: 'agency',
    path: '/settings',
    title: 'Settings',
    surface: 'none',
    rail: true,
    authenticated: true,
  },
];

export interface RouteMatch {
  readonly route: RouteDescriptor;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The matcher. Small on purpose: no router package is named in
 * `docs/platform-construction.md`, and the list above has to be the thing the
 * application resolves through or a discovery check is reading a decoration.
 */
export function matchRoute(path: string): RouteMatch | null {
  const asked = segments(path);
  for (const route of ROUTES) {
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
    if (matched) return { route, params };
  }
  return null;
}

/**
 * The address of a registered route, with its parameters filled in.
 *
 * Every link and navigation goes through this rather than typing the path out,
 * so the registry stays the one place an address is spelt.
 */
export function pathTo(id: RouteId, params: Readonly<Record<string, string>> = {}): string {
  const route = ROUTES.find((entry) => entry.id === id);
  if (route === undefined) throw new Error(`no route is registered as ${id}`);
  return route.path.replace(/:([a-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${id} needs the parameter ${name}`);
    return encodeURIComponent(value);
  });
}

const segments = (path: string): readonly string[] => path.split('/').filter((part) => part !== '');

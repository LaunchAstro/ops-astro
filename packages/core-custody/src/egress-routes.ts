// SPDX-License-Identifier: AGPL-3.0-only
//
// What a destination adds to, and allows beyond, a POST (AW-13): fixed
// headers custody sets on every request to it, and the few DELETE, GET and
// PUT routes it answers (the trace store's expiry and the read that confirms
// it; the login provider's update of one user, C40). Both are custody's own
// list, read once at start; a caller names neither. A destination marked
// `post: false` takes a POST only on a route it lists by exact path: the login
// provider's, whose service key could otherwise mint sign-in links or users
// (C40 security review M1), lists the one user creation an accept makes (C39-T).

/**
 * A listed route: an exact path, or for a GET one trailing `/*` segment.
 * A PUT is only ever one `/*` segment under a prefix, never an exact path;
 * a POST only ever an exact path, and only a `post: false` destination needs one.
 */
export interface Route {
  readonly method: 'DELETE' | 'GET' | 'PUT' | 'POST';
  readonly path: string;
}

export type Method = Route['method'];

export const METHODS: readonly Method[] = ['POST', 'DELETE', 'GET', 'PUT'];

/** A lower-case token: one spelling per name, so no two can collide by case. */
const HEADER_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
/** Visible ASCII, inner spaces only: no CR, LF, tab or other control byte. */
const HEADER_VALUE = /^[!-~](?:[ -~]{0,254}[!-~])?$/u;
/** Names custody or the transport owns: the credential, framing and routing. */
const RESERVED = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
  'expect',
]);
/** Plain segments from the root; no empty, `.` or `..` segment. */
const ROUTE_PATH = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+$/u;
/** What a `/*` stands for: one identifier segment. */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;

export interface Extras {
  readonly headers?: Readonly<Record<string, string>>;
  readonly routes?: readonly Route[];
  /** `false`: no POST to any path, only the listed routes. */
  readonly post?: false;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function headersOf(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const valid = entries.every(
    ([name, text]) =>
      HEADER_NAME.test(name) &&
      !RESERVED.has(name) &&
      typeof text === 'string' &&
      HEADER_VALUE.test(text),
  );
  return valid ? Object.fromEntries(entries as [string, string][]) : undefined;
}

function routeOf(value: unknown): Route | undefined {
  if (!isObject(value) || Object.keys(value).toSorted().join() !== 'method,path') return undefined;
  const { method, path } = value;
  if (typeof path !== 'string') return undefined;
  if ((method === 'DELETE' || method === 'POST') && ROUTE_PATH.test(path)) return { method, path };
  const prefix = path.endsWith('/*') ? path.slice(0, -2) : path;
  if (method === 'GET' && ROUTE_PATH.test(prefix)) return { method, path };
  if (method === 'PUT' && prefix !== path && ROUTE_PATH.test(prefix)) return { method, path };
  return undefined;
}

/** A destination entry's headers, routes and POST bar, or `undefined` when one is malformed. */
export function parseExtras(entry: Readonly<Record<string, unknown>>): Extras | undefined {
  const extras: { headers?: Record<string, string>; routes?: Route[]; post?: false } = {};
  if (entry['post'] !== undefined) {
    if (entry['post'] !== false) return undefined;
    extras.post = false;
  }
  if (entry['headers'] !== undefined) {
    const headers = headersOf(entry['headers']);
    if (headers === undefined) return undefined;
    extras.headers = headers;
  }
  if (entry['routes'] !== undefined) {
    if (!Array.isArray(entry['routes'])) return undefined;
    const routes = entry['routes'].map(routeOf);
    if (routes.some((route) => route === undefined)) return undefined;
    // A POST route bars the others only where the destination takes no other POST.
    if (routes.some((route) => route?.method === 'POST') && extras.post !== false) return undefined;
    extras.routes = routes as Route[];
  }
  return extras;
}

/** A path under the origin: starts with one slash, no scheme, no authority, no traversal, no control bytes. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/u;

/**
 * A path a request may name: a plain path under the origin for a POST, as
 * before, unless the destination takes none; for a POST there and any other
 * method, only a route the destination lists.
 */
export function pathAllowed(extras: Extras, method: Method, path: string): boolean {
  if (!PATH.test(path) || path.includes('..')) return false;
  if (method === 'POST' && extras.post !== false) return true;
  return (extras.routes ?? []).some((route) => {
    if (route.method !== method) return false;
    if (!route.path.endsWith('/*')) return route.path === path;
    const prefix = route.path.slice(0, -1);
    return path.startsWith(prefix) && SEGMENT.test(path.slice(prefix.length));
  });
}

// A request that did not succeed comes back as the fault's kind and the status,
// and for a refusal its `error_code` when custody names that code: one status
// can mean two things (the login provider's 422, C39-T SEC-P3A-1 S1). Nothing
// else of the answer leaves custody, which may carry anything, a credential too.

export type OutboundFault =
  | 'unlisted'
  | 'bad_path'
  | 'forbidden'
  | 'redirect'
  | 'timeout'
  | 'too_large'
  | 'status'
  | 'network';

export interface OutboundFailure {
  readonly ok: false;
  readonly fault: OutboundFault;
  readonly status: number | null;
  /** A refusal's `error_code`, one of `REFUSAL_CODES`; never the answer itself. */
  readonly code?: string;
}

/** The login provider's refusals that say what a 4xx meant (C39-T). */
const REFUSAL_CODES = new Set<unknown>(['email_exists', 'user_not_found', 'weak_password']);

/** A status outside 2xx as a failure, naming its refusal's code when the answer holds one. */
export function statusFault(status: number, text: string): OutboundFailure {
  const failure = { ok: false, fault: 'status', status } as const;
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return failure;
  }
  const code = (answer as Record<string, unknown> | null)?.['error_code'];
  return REFUSAL_CODES.has(code) ? { ...failure, code: code as string } : failure;
}

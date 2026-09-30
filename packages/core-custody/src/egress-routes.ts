// SPDX-License-Identifier: AGPL-3.0-only
//
// What a destination adds to, and allows beyond, a POST (AW-13): fixed
// headers custody sets on every request to it, and the few DELETE and GET
// routes it answers (the trace store's expiry and the read that confirms it).
// Both are custody's own list, read once at start; a caller names neither.

/** A non-POST route: an exact path, or for a GET one trailing `/*` segment. */
export interface Route {
  readonly method: 'DELETE' | 'GET';
  readonly path: string;
}

export type Method = 'POST' | Route['method'];

export const METHODS: readonly Method[] = ['POST', 'DELETE', 'GET'];

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
  if (method === 'DELETE' && ROUTE_PATH.test(path)) return { method, path };
  const prefix = path.endsWith('/*') ? path.slice(0, -2) : path;
  if (method === 'GET' && ROUTE_PATH.test(prefix)) return { method, path };
  return undefined;
}

/** A destination entry's headers and routes, or `undefined` when either is malformed. */
export function parseExtras(entry: Readonly<Record<string, unknown>>): Extras | undefined {
  const extras: { headers?: Record<string, string>; routes?: Route[] } = {};
  if (entry['headers'] !== undefined) {
    const headers = headersOf(entry['headers']);
    if (headers === undefined) return undefined;
    extras.headers = headers;
  }
  if (entry['routes'] !== undefined) {
    if (!Array.isArray(entry['routes'])) return undefined;
    const routes = entry['routes'].map(routeOf);
    if (routes.some((route) => route === undefined)) return undefined;
    extras.routes = routes as Route[];
  }
  return extras;
}

/** A path under the origin: starts with one slash, no scheme, no authority, no traversal, no control bytes. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/u;

/**
 * A path a request may name: a plain path under the origin for a POST, as
 * before; for any other method, only a route the destination lists.
 */
export function pathAllowed(extras: Extras, method: Method, path: string): boolean {
  if (!PATH.test(path) || path.includes('..')) return false;
  if (method === 'POST') return true;
  return (extras.routes ?? []).some((route) => {
    if (route.method !== method) return false;
    if (!route.path.endsWith('/*')) return route.path === path;
    const prefix = route.path.slice(0, -1);
    return path.startsWith(prefix) && SEGMENT.test(path.slice(prefix.length));
  });
}

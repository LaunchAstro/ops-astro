// SPDX-License-Identifier: AGPL-3.0-only
//
// What a destination adds to, and allows beyond, a POST (AW-13): fixed
// headers custody sets on every request to it, and the few DELETE, GET and
// PUT routes it answers (the trace store's expiry and the read that confirms
// it; the login provider's update of one user, C40). Both are custody's own
// list, read once at start; a caller names neither. A destination marked
// `post: false` takes no POST at all, only its listed routes: the login
// provider's, whose service key could otherwise mint sign-in links or users
// (C40 security review M1). A destination with `posts` takes a POST to those
// exact paths only: the mail provider's, whose key could otherwise create keys
// or read contacts. A destination may declare the stream format custody
// decodes for it (`stream: 'openai_sse'`, #1508).
//
// A route may instead be a catalogued call's fixed template, query included
// (`/v6/deployments?projectId={project}&target=production`): a `{name}` slot
// is one segment or query value, a `{name*}` slot one segment or more. A
// request matches it whole or not at all, so no query is free. A query value
// is what `URLSearchParams` writes for one value: unreserved characters, `+`
// and upper-case `%XX` escapes (a branch named `a/b` or `a+b`), never a raw
// `&`, `=`, `?`, `#` or a lone `%`, so it cannot add a parameter. Each template route names the fields its answer is cut to
// (`fields`, the catalogued response schema, at most four).

import type { Fields } from './egress-answer.ts';

/**
 * A non-POST route: an exact path, or for a GET one trailing `/*` segment.
 * A PUT is only ever one `/*` segment under a prefix, never an exact path.
 */
export interface PathRoute {
  readonly method: 'DELETE' | 'GET' | 'PUT';
  readonly path: string;
}

/** A catalogued call's whole shape, path and query, and the fields its answer keeps. */
export interface TemplateRoute {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly template: string;
  readonly fields: Fields;
}

export type Route = PathRoute | TemplateRoute;

export type Method = 'POST' | Route['method'];

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
  /** The only paths a POST may name; absent, any plain path. */
  readonly posts?: readonly string[];
  /** A stream format custody decodes itself, so a presented key may stream (#1508). */
  readonly stream?: 'openai_sse';
}

/**
 * A template's path: literal segments (never `.` or `..`, and no longer than
 * a slot's segment, so every literal is a segment `PATH_SLOT` admits) and slots.
 */
const TEMPLATE_PATH = /^(?:\/(?:\{[a-z]+\*?\}|(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]{1,256}))+$/u;
/** A template's query: each parameter a literal value or one slot. */
const TEMPLATE_QUERY =
  /^[A-Za-z]+=(?:\{[a-z]+\}|[A-Za-z0-9._~-]+)(?:&[A-Za-z]+=(?:\{[a-z]+\}|[A-Za-z0-9._~-]+))*$/u;
/** What a path slot stands for: one segment, never `.` or `..`, and no escape. */
const PATH_SLOT = /^(?!\.\.?$)[A-Za-z0-9._~-]{1,256}$/u;
/** What a query slot stands for: one value as `URLSearchParams` writes it. */
const QUERY_SLOT = /^(?:[A-Za-z0-9*._~+-]|%[0-9A-F]{2}){1,768}$/u;
/** A template slot: `{name}` for one segment or value, `{name*}` for one segment or more. */
const SLOT = /^\{[a-z]+(\*?)\}$/u;
/** A declared field: dotted names, as the catalogue writes them. */
const FIELD = /^[A-Za-z0-9_$]{1,64}(?:\.[A-Za-z0-9_$]{1,64}){0,7}$/u;
const KINDS: ReadonlySet<unknown> = new Set(['string', 'number', 'boolean']);
/** A schema of more fields would make custody's echo check (`withholds`) too costly. */
const MOST_FIELDS = 4;

function templateOf(template: string): boolean {
  const [path = '', query, ...more] = template.split('?');
  return (
    more.length === 0 &&
    TEMPLATE_PATH.test(path) &&
    (query === undefined || TEMPLATE_QUERY.test(query))
  );
}

/** The text before and after the first `?`, or the whole and undefined. */
function split(text: string): readonly [string, string | undefined] {
  const at = text.indexOf('?');
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

/** Whether a template segment that is no many-segment slot takes this path segment. */
const takes = (want: string, given: string | undefined): boolean =>
  given !== undefined && (want === given || SLOT.exec(want)?.[1] === '');

/** Whether `block` takes the path's segments from `at` on. */
const blockAt = (block: readonly string[], path: readonly string[], at: number): boolean =>
  block.every((want, offset) => takes(want, path[at + offset]));

/**
 * Whether path segments fill template segments: a literal as written, a slot
 * by `PATH_SLOT`, a many-segment slot one segment or more. Every segment is
 * checked once, and the template's many-segment slots split it into blocks:
 * the first is matched from the left, the last from the right, and each other
 * at its first place after one segment or more. No literal is a segment
 * `PATH_SLOT` refuses, so a path with one fills nothing, and a slot never
 * needs a later place than the first; the time is the path's length times
 * the template's, and nothing recurses.
 */
function segmentsFill(template: readonly string[], path: readonly string[]): boolean {
  if (!path.every((segment) => PATH_SLOT.test(segment))) return false;
  const blocks: string[][] = [[]];
  for (const want of template) {
    if (SLOT.exec(want)?.[1] === '*') blocks.push([]);
    else blocks.at(-1)?.push(want);
  }
  const [first = [], ...others] = blocks;
  const last = others.pop();
  if (last === undefined) return path.length === first.length && blockAt(first, path, 0);
  const end = path.length - last.length;
  if (end < first.length || !blockAt(first, path, 0) || !blockAt(last, path, end)) return false;
  let at = first.length;
  for (const block of others) {
    let place = at + 1;
    while (place + block.length < end && !blockAt(block, path, place)) place += 1;
    if (place + block.length >= end) return false;
    at = place + block.length;
  }
  return end - at >= 1;
}

/** Whether query parameters fill the template's, in order: a literal value as written, a slot by `QUERY_SLOT`. */
function queryFills(template: readonly string[], query: readonly string[]): boolean {
  return (
    template.length === query.length &&
    template.every((want, at) => {
      const [name = '', value = ''] = want.split('=');
      const given = query[at] ?? '';
      if (!given.startsWith(`${name}=`)) return false;
      const sent = given.slice(name.length + 1);
      return SLOT.test(value) ? QUERY_SLOT.test(sent) : sent === value;
    })
  );
}

/** Whether a request's path and query fill the template exactly, by comparison and fixed checks only. */
function fills(template: string, path: string): boolean {
  const [wantPath, wantQuery] = split(template);
  const [givenPath, givenQuery] = split(path);
  if ((wantQuery === undefined) !== (givenQuery === undefined)) return false;
  if (!givenPath.startsWith('/')) return false;
  if (!segmentsFill(wantPath.slice(1).split('/'), givenPath.slice(1).split('/'))) return false;
  return wantQuery === undefined || queryFills(wantQuery.split('&'), (givenQuery ?? '').split('&'));
}

function fieldsOf(value: unknown): Fields | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const valid =
    entries.length <= MOST_FIELDS &&
    entries.every(([name, kind]) => FIELD.test(name) && KINDS.has(kind));
  return valid ? (Object.fromEntries(entries) as Fields) : undefined;
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
  if (isObject(value) && Object.keys(value).toSorted().join() === 'fields,method,template') {
    const { method, template } = value;
    const fields = fieldsOf(value['fields']);
    const known = method === 'GET' || method === 'POST' || method === 'PUT';
    return known && typeof template === 'string' && templateOf(template) && fields !== undefined
      ? { method, template, fields }
      : undefined;
  }
  if (!isObject(value) || Object.keys(value).toSorted().join() !== 'method,path') return undefined;
  const { method, path } = value;
  if (typeof path !== 'string') return undefined;
  if (method === 'DELETE' && ROUTE_PATH.test(path)) return { method, path };
  const prefix = path.endsWith('/*') ? path.slice(0, -2) : path;
  if (method === 'GET' && ROUTE_PATH.test(prefix)) return { method, path };
  if (method === 'PUT' && prefix !== path && ROUTE_PATH.test(prefix)) return { method, path };
  return undefined;
}

/** A destination entry's headers, routes and POST bar, or `undefined` when one is malformed. */
export function parseExtras(entry: Readonly<Record<string, unknown>>): Extras | undefined {
  const extras: {
    headers?: Record<string, string>;
    routes?: Route[];
    post?: false;
    posts?: string[];
    stream?: 'openai_sse';
  } = {};
  if (entry['stream'] !== undefined) {
    if (entry['stream'] !== 'openai_sse') return undefined;
    extras.stream = 'openai_sse';
  }
  if (entry['post'] !== undefined) {
    if (entry['post'] !== false) return undefined;
    extras.post = false;
  }
  if (entry['posts'] !== undefined) {
    const posts = entry['posts'];
    // A list that names no path, or one beside `post: false`, says two things at once.
    if (!Array.isArray(posts) || posts.length === 0 || extras.post === false) return undefined;
    if (!posts.every((path) => typeof path === 'string' && ROUTE_PATH.test(path))) {
      return undefined;
    }
    extras.posts = posts as string[];
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
    extras.routes = routes as Route[];
  }
  return extras;
}

/** The longest path, query included, a request may name: no route needs more. */
const MOST_PATH = 8_192;

/** A path under the origin: starts with one slash, no scheme, no authority, no traversal, no control bytes. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/u;

/**
 * A path a request may name: a plain path under the origin for a POST, as
 * before, unless the destination takes none or lists the only ones it takes;
 * for any other method, only a route the destination lists.
 */
export function pathAllowed(extras: Extras, method: Method, path: string): boolean {
  if (path.length > MOST_PATH) return false;
  const routes = extras.routes ?? [];
  if (templateFilled(extras, method, path) !== undefined) return true;
  if (!PATH.test(path) || path.includes('..')) return false;
  if (method === 'POST') {
    return extras.post !== false && (extras.posts === undefined || extras.posts.includes(path));
  }
  return routes.some((route) => {
    if (!('path' in route) || route.method !== method) return false;
    if (!route.path.endsWith('/*')) return route.path === path;
    const prefix = route.path.slice(0, -1);
    return path.startsWith(prefix) && SEGMENT.test(path.slice(prefix.length));
  });
}

/** The template route a request fills, if any: its answer is cut to the route's fields. */
export function templateFilled(
  extras: Extras,
  method: Method,
  path: string,
): TemplateRoute | undefined {
  return (extras.routes ?? []).find(
    (route): route is TemplateRoute =>
      'template' in route && route.method === method && fills(route.template, path),
  );
}

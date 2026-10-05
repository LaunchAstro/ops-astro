// SPDX-License-Identifier: AGPL-3.0-only
//
// The socket proxy's request grammar (docs/plan/sandbox-contract.md, P1, P2,
// P4's request forms, P5's query form and P7). A launcher request is read
// as one HTTP/1.1 request whose every part is checked against a closed
// form: the request line, each header by name, the path segment by
// segment, the query as one of a few exact strings, and the body. Whatever
// the grammar does not name is refused. What is forwarded is rebuilt from
// the checked operation by `forwardBytes`, never copied from the request.
//
// Whether an id is one the proxy recorded, or an image one the pin list
// holds, is the proxy's state, checked after this grammar (P3, P4, P5).

import { type CreateShape, matchCreateBody } from './create-body.ts';
import { refuse, type Result } from './refusal.ts';
import { MAX_JSON_BYTES, parseStrictJson } from './strict-json.ts';

export type ContainerAction = 'attach' | 'start' | 'wait' | 'kill' | 'inspect' | 'delete';

export type ProxyOp =
  | { readonly kind: 'ping' | 'version' | 'info' }
  | { readonly kind: 'create'; readonly shape: CreateShape; readonly image: string }
  | { readonly kind: Exclude<ContainerAction, 'attach'>; readonly id: string }
  | {
      readonly kind: 'attach';
      readonly id: string;
      /**
       * Where the stdin stream starts in the bytes read: attach is the one
       * stream (P1). The daemon drops stdin sent before its 101 reply, so
       * the proxy holds these bytes until that reply.
       */
      readonly bodyStart: number;
    }
  | {
      readonly kind: 'load';
      readonly site: string | null;
      /** The launcher's declared archive length, which the proxy reads to and never forwards. */
      readonly declaredLength: number;
      /** Where the archive starts in the bytes read. */
      readonly bodyStart: number;
    }
  | { readonly kind: 'image-inspect' | 'image-delete'; readonly image: string };

export type ProxyGrammar = {
  /** The pinned API version, such as `1.47`. */
  readonly apiVersion: string;
  /** The create shapes the pin list allows now. */
  readonly shapes: readonly CreateShape[];
};

/**
 * Not all of the request has arrived: read again with more bytes. Never a
 * refusal. `need` is the whole request's length once the head says it, so
 * the caller reads again only when that many bytes are in.
 */
export type More = { readonly ok: 'more'; readonly need: number | null };
const MORE: More = { ok: 'more', need: null };

/** A request read whole, refused, or not yet complete. */
export type ProxyRead = Result<{ op: ProxyOp }> | More;

type Head = {
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  readonly headers: ReadonlyMap<string, string>;
  readonly rest: Uint8Array;
  readonly bodyStart: number;
};

const MAX_HEAD = 8192;
const REQUEST_LINE = /^(GET|POST|DELETE) (\/[!-~]*) HTTP\/1\.1$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// The two classes share no character, so the match is linear in the line.
const HEADER_VALUE = /^(?:[!-~]+(?:[ \t]+[!-~]+)*)?$/u;
const HEADERS = new Set(['host', 'content-type', 'content-length', 'connection', 'upgrade']);
const HOST = /^[A-Za-z0-9.-]+$/u;
const SEGMENT = /^[A-Za-z0-9_.:-]+$/u;
export const CONTAINER_ID: RegExp = /^[0-9a-f]{64}$/u;
export const IMAGE_ID: RegExp = /^sha256:[0-9a-f]{64}$/u;
// At most 15 digits, so every length is an exact integer.
const LENGTH = /^(?:0|[1-9]\d{0,14})$/u;
export const ATTACH_QUERY: string = 'stream=1&stdin=1&stdout=1&stderr=1';
const LOAD_QUERY = /^quiet=1(?:&site=([a-z0-9-]{1,64}))?$/u;
const CONTAINER_ACTIONS: Readonly<Record<string, readonly [string, ContainerAction]>> = {
  attach: ['POST', 'attach'],
  start: ['POST', 'start'],
  wait: ['POST', 'wait'],
  kill: ['POST', 'kill'],
  json: ['GET', 'inspect'],
};

/** The value without its leading and trailing spaces and tabs (optional whitespace). */
function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start += 1;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return text.slice(start, end);
}

function readHead(bytes: Uint8Array): Result<{ head: Head }> | More {
  let end = -1;
  for (let i = 0; i + 3 < bytes.length && i < MAX_HEAD; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0) return bytes.length < MAX_HEAD + 4 ? MORE : refuse('request line');
  const lines = new TextDecoder('latin1').decode(bytes.subarray(0, end)).split('\r\n');
  const line = REQUEST_LINE.exec(lines[0] ?? '');
  if (line === null) return refuse('request line');
  const headers = new Map<string, string>();
  for (const raw of lines.slice(1)) {
    const colon = raw.indexOf(':');
    const value = trimSpace(raw.slice(colon + 1));
    if (colon < 0 || !HEADER_NAME.test(raw.slice(0, colon)) || !HEADER_VALUE.test(value)) {
      return refuse('header');
    }
    const name = raw.slice(0, colon).toLowerCase();
    if (name === 'transfer-encoding') return refuse('transfer-encoding');
    if (!HEADERS.has(name) || headers.has(name)) return refuse('header');
    headers.set(name, value);
  }
  if (!HOST.test(headers.get('host') ?? '')) return refuse('header');
  const target = line[2] as string;
  const mark = target.indexOf('?');
  return {
    ok: true,
    head: {
      method: line[1] as string,
      path: mark < 0 ? target : target.slice(0, mark),
      query: mark < 0 ? null : target.slice(mark + 1),
      headers,
      rest: bytes.subarray(end + 4),
      bodyStart: end + 4,
    },
  };
}

function segmentsOf(path: string, apiVersion: string): Result<{ segments: readonly string[] }> {
  const prefix = `/v${apiVersion}/`;
  if (!path.startsWith(prefix)) return refuse('version');
  const segments = path.slice(prefix.length).split('/');
  const bad = segments.some((s) => s === '.' || s === '..' || !SEGMENT.test(s));
  return bad ? refuse('path') : { ok: true, segments };
}

/** A route names its operation, or `create`, whose shape comes from the body. */
type Route = { readonly op: ProxyOp | 'create'; readonly query: string | null };

function routeOf(method: string, segments: readonly string[], query: string | null): Result<Route> {
  const [first, second, third, ...more] = segments;
  if (more.length > 0) return refuse('unknown route');
  if (method === 'GET' && third === undefined && second === undefined) {
    if (first === '_ping') return { ok: true, op: { kind: 'ping' }, query: null };
    if (first === 'version' || first === 'info')
      return { ok: true, op: { kind: first }, query: null };
  }
  if (first === 'containers' && second !== undefined) return containerRoute(method, second, third);
  if (first === 'images' && second !== undefined) return imageRoute(method, second, third, query);
  return refuse('unknown route');
}

function containerRoute(method: string, second: string, third: string | undefined): Result<Route> {
  if (third === undefined) {
    if (method === 'POST' && second === 'create') return { ok: true, op: 'create', query: null };
    if (method !== 'DELETE') return refuse('unknown route');
    if (!CONTAINER_ID.test(second)) return refuse('container id');
    return { ok: true, op: { kind: 'delete', id: second }, query: 'force=1' };
  }
  const action = CONTAINER_ACTIONS[third];
  if (action === undefined || action[0] !== method) return refuse('unknown route');
  if (!CONTAINER_ID.test(second)) return refuse('container id');
  if (action[1] === 'attach') {
    return { ok: true, op: { kind: 'attach', id: second, bodyStart: 0 }, query: ATTACH_QUERY };
  }
  return { ok: true, op: { kind: action[1], id: second }, query: null };
}

function imageRoute(
  method: string,
  second: string,
  third: string | undefined,
  query: string | null,
): Result<Route> {
  if (method === 'POST' && second === 'load' && third === undefined) {
    const load = LOAD_QUERY.exec(query ?? '');
    if (load === null) return refuse('query');
    const site = load[1] ?? null;
    return { ok: true, op: { kind: 'load', site, declaredLength: 0, bodyStart: 0 }, query };
  }
  const inspect = method === 'GET' && third === 'json';
  const remove = method === 'DELETE' && third === undefined;
  if (!inspect && !remove) return refuse('unknown route');
  if (!IMAGE_ID.test(second)) return refuse('image id');
  return {
    ok: true,
    op: { kind: inspect ? 'image-inspect' : 'image-delete', image: second },
    query: null,
  };
}

/** The body rules for one operation: its content type, its length, and nothing after it. */
function readBody(head: Head, op: ProxyOp | 'create', grammar: ProxyGrammar): ProxyRead {
  const isCreate = op === 'create';
  const type = head.headers.get('content-type');
  const length = head.headers.get('content-length');
  const upgrade = head.headers.has('connection') || head.headers.has('upgrade');
  if (op !== 'create' && op.kind === 'attach') {
    if (head.headers.get('connection') !== 'Upgrade' || head.headers.get('upgrade') !== 'tcp')
      return refuse('header');
    if (type !== undefined || length !== undefined) return refuse('body');
    // Bytes after an attach head are the start of its stdin stream, not a request.
    return { ok: true, op: { ...op, bodyStart: head.bodyStart } };
  }
  if (upgrade) return refuse('header');
  if (op !== 'create' && op.kind !== 'load') {
    if (type !== undefined || (length !== undefined && length !== '0')) return refuse('body');
    return head.rest.length > 0 ? refuse('second request') : { ok: true, op };
  }
  const expected = isCreate ? 'application/json' : 'application/x-tar';
  if (type !== expected || length === undefined || !LENGTH.test(length)) return refuse('body');
  const declared = Number(length);
  if (head.rest.length > declared) return refuse('second request');
  if (op !== 'create')
    return { ok: true, op: { ...op, declaredLength: declared, bodyStart: head.bodyStart } };
  if (declared > MAX_JSON_BYTES) return refuse('body');
  if (head.rest.length < declared) return { ok: 'more', need: head.bodyStart + declared };
  const parsed = parseStrictJson(head.rest, { foldCase: true });
  if (!parsed.ok) return refuse(parsed.why);
  const match = matchCreateBody(parsed.value, grammar.shapes);
  return match.ok
    ? { ok: true, op: { kind: 'create', shape: match.shape, image: match.image } }
    : match;
}

export function readProxyRequest(bytes: Uint8Array, grammar: ProxyGrammar): ProxyRead {
  const read = readHead(bytes);
  if (read.ok !== true) return read;
  const { head } = read;
  const path = segmentsOf(head.path, grammar.apiVersion);
  if (!path.ok) return path;
  const route = routeOf(head.method, path.segments, head.query);
  if (!route.ok) return route;
  if (head.query !== route.query) return refuse('query');
  return readBody(head, route.op, grammar);
}

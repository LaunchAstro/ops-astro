// SPDX-License-Identifier: AGPL-3.0-only
//
// The one place a model call leaves the machine (AW-01, standing gate 9).
//
// It runs inside custody's process only. A request names a destination key
// and a path; the origin comes from custody's own list, never from the
// caller. No redirect is followed, to a listed host or any other. Every answer
// is bounded by a timeout and a byte limit counted off the stream, and the
// read stops at the limit rather than after it.
//
// A listed name is resolved once, before any socket exists, and the call is
// refused when any address is a metadata, link-local or unspecified one. The
// socket then takes exactly the addresses that were checked, so a second
// lookup answering differently (DNS rebinding) is never asked.

import { lookup as systemLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { presented, type StoredCredential } from './credentials.ts';
import { parseExtras, pathAllowed, type Extras, type Method } from './egress-routes.ts';

/** A listed origin, with any fixed headers and non-POST routes of its own (AW-13). */
export interface Destination extends Extras {
  readonly key: string;
  readonly origin: string;
}

export type DestinationRefusal = 'DESTINATION_MALFORMED' | 'DESTINATION_FORBIDDEN';

/** Link-local and cloud metadata hosts: never a destination, whoever lists them. */
const FORBIDDEN_HOST = [
  /^169\.254\./u,
  /^\[?fe80:/iu,
  /^\[?fd00:ec2::254\]?$/iu,
  /^metadata(\.google\.internal)?$/iu,
  /^0\.0\.0\.0$/u,
];

/** The same hosts by address, IPv4-mapped IPv6 spellings included (BlockList matches those against the IPv4 rules). */
const FORBIDDEN_ADDRESS = new BlockList();
FORBIDDEN_ADDRESS.addSubnet('169.254.0.0', 16, 'ipv4');
FORBIDDEN_ADDRESS.addAddress('0.0.0.0', 'ipv4');
FORBIDDEN_ADDRESS.addSubnet('fe80::', 10, 'ipv6');
FORBIDDEN_ADDRESS.addAddress('fd00:ec2::254', 'ipv6');
FORBIDDEN_ADDRESS.addAddress('::', 'ipv6');

/** Anything that is not an address is forbidden too: a resolver's answer is data, not trust. */
function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return FORBIDDEN_ADDRESS.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** A URL's hostname as an address, when it is one: IPv6 literals lose their brackets. */
const literalOf = (hostname: string): string | undefined => {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 ? undefined : bare;
};

/** Custody's destination list, refused whole on any entry that is not a bare http(s) origin. */
export function parseDestinations(
  entries: unknown,
):
  | { readonly ok: true; readonly destinations: ReadonlyMap<string, Destination> }
  | { readonly ok: false; readonly code: DestinationRefusal; readonly at: number } {
  if (!Array.isArray(entries)) return { ok: false, code: 'DESTINATION_MALFORMED', at: -1 };
  const destinations = new Map<string, Destination>();
  for (const [at, entry] of entries.entries()) {
    const shape = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const { key, origin } = shape;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(key) || destinations.has(key)) {
      return { ok: false, code: 'DESTINATION_MALFORMED', at };
    }
    let url: URL;
    try {
      url = new URL(String(origin));
    } catch {
      return { ok: false, code: 'DESTINATION_MALFORMED', at };
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== origin
    ) {
      return { ok: false, code: 'DESTINATION_MALFORMED', at };
    }
    const literal = literalOf(url.hostname);
    if (
      FORBIDDEN_HOST.some((pattern) => pattern.test(url.hostname)) ||
      (literal !== undefined && forbiddenAddress(literal))
    ) {
      return { ok: false, code: 'DESTINATION_FORBIDDEN', at };
    }
    const extras = parseExtras(shape);
    if (extras === undefined) return { ok: false, code: 'DESTINATION_MALFORMED', at };
    destinations.set(key, { key, origin: url.origin, ...extras });
  }
  return { ok: true, destinations };
}

export interface OutboundRequest {
  readonly destination: string;
  readonly path: string;
  readonly method: Method;
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type OutboundFault =
  | 'unlisted'
  | 'bad_path'
  | 'forbidden'
  | 'redirect'
  | 'timeout'
  | 'too_large'
  | 'status'
  | 'network';

export type Outbound =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: OutboundFault; readonly status: number | null };

async function readBounded(
  response: IncomingMessage,
  limit: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const parts: Buffer[] = [];
  let size = 0;
  // One chunk at a time: the count must stop the read, not follow it.
  for await (const chunk of response) {
    const part = chunk as Buffer;
    size += part.byteLength;
    if (size > limit) {
      response.destroy();
      return { ok: false };
    }
    parts.push(part);
  }
  return { ok: true, text: Buffer.concat(parts).toString('utf8') };
}

/** How a listed name becomes addresses. The system lookup unless a test supplies one. */
export type Resolve = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const resolveBySystem: Resolve = async (hostname) =>
  await systemLookup(hostname, { all: true, order: 'verbatim' });

/** The work, or the signal's reason once it aborts. The listener goes when the race ends. */
async function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const done = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason);
      },
      { once: true, signal: done.signal },
    );
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    done.abort();
  }
}

/**
 * The addresses the socket may take, every one checked: none when any is
 * forbidden or the lookup fails, and `timeout` when the request's time ran out
 * first, since the lookup is part of the call.
 */
async function checkedAddresses(
  url: URL,
  resolve: Resolve,
  signal: AbortSignal,
): Promise<readonly LookupAddress[] | 'timeout'> {
  const literal = literalOf(url.hostname);
  let addresses: readonly LookupAddress[];
  try {
    addresses =
      literal === undefined
        ? await within(resolve(url.hostname), signal)
        : [{ address: literal, family: isIP(literal) }];
  } catch {
    return signal.aborted ? 'timeout' : [];
  }
  return addresses.some((entry) => forbiddenAddress(entry.address)) ? [] : addresses;
}

/** A lookup that answers only with the checked addresses: the socket never resolves the name again. */
const pinnedTo =
  (addresses: readonly LookupAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    const [first] = addresses;
    if (options.all === true) callback(null, [...addresses]);
    else if (first !== undefined) callback(null, first.address, first.family);
  };

/** A response read within its limit. A redirect is answered, never followed. */
async function answerOf(
  response: IncomingMessage,
  limit: number,
  failed: (status: number | null) => Outbound,
): Promise<Outbound> {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    return { ok: false, fault: 'redirect', status };
  }
  let read: Awaited<ReturnType<typeof readBounded>>;
  try {
    read = await readBounded(response, limit);
  } catch {
    return failed(status);
  }
  if (!read.ok) return { ok: false, fault: 'too_large', status };
  if (status < 200 || status >= 300) return { ok: false, fault: 'status', status };
  return { ok: true, status, body: read.text };
}

/** One request and its bounded answer. */
async function exchange(
  url: URL,
  options: RequestOptions,
  body: string,
  limit: number,
): Promise<Outbound> {
  const signal = options.signal;
  return await new Promise<Outbound>((settle) => {
    const failed = (status: number | null): Outbound => ({
      ok: false,
      fault: signal?.aborted === true ? 'timeout' : 'network',
      status,
    });
    const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options);
    outgoing.on('response', (response) => {
      void answerOf(response, limit, failed).then(settle);
    });
    outgoing.on('error', () => {
      settle(failed(null));
    });
    outgoing.end(body);
  });
}

/**
 * Send one request to a listed destination with the credential header and
 * the destination's fixed headers custody adds. The caller never supplies the
 * origin, a header, or a method the destination does not route.
 */
export async function send(
  destinations: ReadonlyMap<string, Destination>,
  request: OutboundRequest,
  credential: Pick<StoredCredential, 'header' | 'scheme' | 'value'> | null,
  resolve: Resolve = resolveBySystem,
): Promise<Outbound> {
  const destination = destinations.get(request.destination);
  if (destination === undefined) return { ok: false, fault: 'unlisted', status: null };
  if (!pathAllowed(destination, request.method, request.path)) {
    return { ok: false, fault: 'bad_path', status: null };
  }
  const url = new URL(request.path, destination.origin);
  if (url.origin !== destination.origin) return { ok: false, fault: 'bad_path', status: null };
  // One deadline for the whole call, the lookup included.
  const signal = AbortSignal.timeout(request.timeoutMs);
  const addresses = await checkedAddresses(url, resolve, signal);
  if (addresses === 'timeout') return { ok: false, fault: 'timeout', status: null };
  if (addresses.length === 0) return { ok: false, fault: 'forbidden', status: null };
  // The destination's fixed headers first; their names never overlap these.
  const headers: Record<string, string> = {
    ...destination.headers,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(request.body)),
  };
  if (credential !== null) headers[credential.header] = presented(credential);
  return await exchange(
    url,
    {
      method: request.method,
      headers,
      lookup: pinnedTo(addresses),
      signal,
    },
    request.body,
    request.maxResponseBytes,
  );
}

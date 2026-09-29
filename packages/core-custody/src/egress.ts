// SPDX-License-Identifier: AGPL-3.0-only
//
// The one place a model call leaves the machine (AW-01, standing gate 9).
//
// It runs inside custody's process only. A request names a destination key
// and a path; the origin comes from custody's own list, never from the
// caller. No redirect is followed, to a listed host or any other. Every answer
// is bounded by a timeout and a byte limit counted off the stream, and the
// read stops at the limit rather than after it.

export interface Destination {
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
    if (FORBIDDEN_HOST.some((pattern) => pattern.test(url.hostname))) {
      return { ok: false, code: 'DESTINATION_FORBIDDEN', at };
    }
    destinations.set(key, { key, origin: url.origin });
  }
  return { ok: true, destinations };
}

export interface OutboundRequest {
  readonly destination: string;
  readonly path: string;
  readonly method: 'POST';
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type OutboundFault =
  'unlisted' | 'bad_path' | 'redirect' | 'timeout' | 'too_large' | 'status' | 'network';

export type Outbound =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: OutboundFault; readonly status: number | null };

/** A path under the origin: starts with one slash, no scheme, no authority, no traversal, no control bytes. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/u;

async function readBounded(
  response: Response,
  limit: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { ok: true, text: '' };
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // One chunk at a time: the count must stop the read, not follow it.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel();
      return { ok: false };
    }
    parts.push(value);
  }
  return { ok: true, text: Buffer.concat(parts).toString('utf8') };
}

/** How a listed name becomes addresses. The system lookup unless a test supplies one. */
export type Resolve = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

/**
 * Send one request to a listed destination with the credential header
 * custody adds. The caller never supplies the origin.
 */
export async function send(
  destinations: ReadonlyMap<string, Destination>,
  request: OutboundRequest,
  credential: { readonly header: string; readonly value: string } | null,
  _resolve?: Resolve,
): Promise<Outbound> {
  const destination = destinations.get(request.destination);
  if (destination === undefined) return { ok: false, fault: 'unlisted', status: null };
  if (!PATH.test(request.path) || request.path.includes('..')) {
    return { ok: false, fault: 'bad_path', status: null };
  }
  const url = new URL(request.path, destination.origin);
  if (url.origin !== destination.origin) return { ok: false, fault: 'bad_path', status: null };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (credential !== null) {
    headers[credential.header] =
      credential.header === 'authorization' ? `Bearer ${credential.value}` : credential.value;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return { ok: false, fault: timedOut ? 'timeout' : 'network', status: null };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ok: false, fault: 'redirect', status: response.status };
  }
  let read: Awaited<ReturnType<typeof readBounded>>;
  try {
    read = await readBounded(response, request.maxResponseBytes);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return { ok: false, fault: timedOut ? 'timeout' : 'network', status: response.status };
  }
  if (!read.ok) return { ok: false, fault: 'too_large', status: response.status };
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, fault: 'status', status: response.status };
  }
  return { ok: true, status: response.status, body: read.text };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The C18-1 fence around page capture: pages already in the catalogue, the
// capture's own pool, no provider credential, no private network, and the
// hard denies checked on the resolved address at every redirect. Pages
// outside the agency's own stay refused until three other-company
// adversarial reviews of the pool are recorded closed (D17-14).

import { isIP } from 'node:net';
import { isDeniedAddress, type Resolver, type Transport } from './transport.ts';

export interface CapturePool {
  /** The agency's own catalogued pages, exact addresses. */
  readonly agencyPages: readonly string[];
  /** Other catalogued pages, reachable only once the pool's reviews are closed. */
  readonly otherPages: readonly string[];
  /** Identities of the other-company adversarial reviews of the pool recorded closed. */
  readonly closedPoolReviews: readonly string[];
}

export const POOL_REVIEWS_REQUIRED = 3;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'page-capture (fenced; no credentials)';

export type FenceCode =
  | 'CAPTURE_HOST_NOT_CATALOGUED'
  | 'CAPTURE_POOL_REVIEWS_OPEN'
  | 'CAPTURE_ADDRESS_DENIED'
  | 'CAPTURE_ADDRESS_CHANGED'
  | 'CAPTURE_TOO_MANY_REDIRECTS'
  | 'CAPTURE_TIMEOUT'
  | 'CAPTURE_OVERSIZED'
  | 'CAPTURE_FAILED'
  | 'CAPTURE_STATUS_REFUSED'
  | 'CAPTURE_BODY_MALFORMED';

/** What the path records of a refusal: the code, the hop and the origin only, never a path or query. */
export interface FenceRefusal {
  readonly code: FenceCode;
  readonly hop: number;
  readonly origin: string;
}

export type Fenced<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: FenceCode };

/** The address exactly as written, or nothing: no other spelling of a catalogued page passes. */
function exact(raw: string): URL | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  const plain =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    !url.hostname.endsWith('.') &&
    url.href === raw;
  return plain ? url : undefined;
}

export function checkPageAllowed(raw: string, pool: CapturePool): Fenced<URL> {
  const url = exact(raw);
  const notCatalogued = { ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' } as const;
  if (url === undefined || url.search !== '' || url.hash !== '') return notCatalogued;
  if (pool.agencyPages.includes(url.href)) return { ok: true, value: url };
  if (!pool.otherPages.includes(url.href)) return notCatalogued;
  if (new Set(pool.closedPoolReviews).size < POOL_REVIEWS_REQUIRED) {
    return { ok: false, code: 'CAPTURE_POOL_REVIEWS_OPEN' };
  }
  return { ok: true, value: url };
}

/** A subresource of an allowed page: the same host, nothing else. */
function checkSubresource(raw: string, page: string, pool: CapturePool): Fenced<URL> {
  const owner = checkPageAllowed(page, pool);
  if (!owner.ok) return owner;
  const url = exact(raw);
  if (url === undefined || url.hash !== '' || url.hostname !== owner.value.hostname) {
    return { ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' };
  }
  return { ok: true, value: url };
}

export interface FetchOptions {
  readonly pool: CapturePool;
  readonly resolve: Resolver;
  readonly transport: Transport;
  readonly kind: 'document' | 'stylesheet';
  /** For a stylesheet: the catalogued page it belongs to. */
  readonly page?: string;
  readonly record?: (refusal: FenceRefusal) => void;
}

export interface Fetched {
  readonly url: string;
  readonly address: string;
  readonly status: number;
  readonly body: string;
}

const LIMITS = {
  document: { maxBytes: 2_097_152, type: 'text/html' },
  stylesheet: { maxBytes: 1_048_576, type: 'text/css' },
} as const;

const TRANSPORT_CODES: Record<string, FenceCode> = {
  timeout: 'CAPTURE_TIMEOUT',
  oversized: 'CAPTURE_OVERSIZED',
  failed: 'CAPTURE_FAILED',
  address_changed: 'CAPTURE_ADDRESS_CHANGED',
};

async function pinnedAddress(host: string, resolve: Resolver): Promise<Fenced<string>> {
  let answers: readonly string[];
  try {
    answers = await resolve(host);
  } catch {
    return { ok: false, code: 'CAPTURE_FAILED' };
  }
  // Every answer is checked, not only the one used: a mixed answer is a
  // rebinding attempt waiting for the resolver's order to change.
  if (answers.length === 0 || answers.some(isDeniedAddress)) {
    return { ok: false, code: 'CAPTURE_ADDRESS_DENIED' };
  }
  return { ok: true, value: answers[0] ?? '' };
}

/** One page or stylesheet, fetched through the fence. Every refusal is recorded before it returns. */
export function fencedFetch(start: string, options: FetchOptions): Promise<Fenced<Fetched>> {
  return follow(start, 0, options);
}

/** One hop: checked, resolved, pinned, fetched; a redirect is a new hop checked from the start. */
async function follow(
  current: string,
  hop: number,
  options: FetchOptions,
): Promise<Fenced<Fetched>> {
  const limits = LIMITS[options.kind];
  const origin = URL.canParse(current) ? new URL(current).origin : '';
  const refuse = (code: FenceCode): Fenced<Fetched> => {
    options.record?.({ code, hop, origin });
    return { ok: false, code };
  };
  if (hop > MAX_REDIRECTS) return refuse('CAPTURE_TOO_MANY_REDIRECTS');
  const allowed =
    options.kind === 'document'
      ? checkPageAllowed(current, options.pool)
      : checkSubresource(current, options.page ?? '', options.pool);
  if (!allowed.ok) return refuse(allowed.code);
  const url = allowed.value;
  const address = await pinnedAddress(url.hostname, options.resolve);
  if (!address.ok) return refuse(address.code);
  const answer = await options.transport({
    url,
    address: address.value,
    family: isIP(address.value) === 6 ? 6 : 4,
    method: 'GET',
    headers: { accept: limits.type, 'user-agent': USER_AGENT },
    timeoutMs: 10_000,
    maxBytes: limits.maxBytes,
  });
  if (answer.kind !== 'answer') return refuse(TRANSPORT_CODES[answer.kind] ?? 'CAPTURE_FAILED');
  if ([301, 302, 303, 307, 308].includes(answer.status)) {
    const location = answer.headers['location'];
    if (location === undefined || !URL.canParse(location, url.href)) {
      return refuse('CAPTURE_BODY_MALFORMED');
    }
    return follow(new URL(location, url.href).href, hop + 1, options);
  }
  if (answer.status !== 200) return refuse('CAPTURE_STATUS_REFUSED');
  const type = (answer.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== limits.type) return refuse('CAPTURE_BODY_MALFORMED');
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(answer.body);
  } catch {
    return refuse('CAPTURE_BODY_MALFORMED');
  }
  return { ok: true, value: { url: url.href, address: address.value, status: 200, body } };
}

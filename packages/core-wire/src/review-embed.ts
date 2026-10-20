// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: the live view beside a review's capture. The product frames
// the review's bound page directly; the page proves it is the selected
// frame by loading the product-served embed script, which answers this
// load's ping with a hello echoing its nonce. The product never fetches,
// rewrites or proxies the page. This file is the protocol both ends share
// and the snippet a site maintainer adds.

/** Where the product serves the embed script, read with no sign-in. */
export const REVIEW_EMBED_PATH = '/api/public/review-embed.js';

/** How long a frame load has to say hello before the capture stands alone. */
export const LIVE_HELLO_MS = 3000;

export const LIVE_PROTOCOL = {
  version: 1,
  ping: 'ops-astro.review.ping',
  hello: 'ops-astro.review.hello',
} as const;

/** A nonce is 32 random bytes, base64url without padding. */
export const LIVE_NONCE: RegExp = /^[\w-]{43}$/u;

/**
 * The nonce a ping or hello carries, when `data` is exactly one: a plain
 * object with only `type`, `version` and `nonce`, this protocol's version and
 * a well-formed nonce. Anything else is no message of ours.
 */
export function liveMessage(data: unknown, kind: 'ping' | 'hello'): string | undefined {
  if (
    typeof data !== 'object' ||
    data === null ||
    Object.getPrototypeOf(data) !== Object.prototype
  ) {
    return undefined;
  }
  const keys = Object.keys(data);
  if (keys.length !== 3) return undefined;
  const { type, version, nonce } = data as Record<string, unknown>;
  return type === LIVE_PROTOCOL[kind] &&
    version === LIVE_PROTOCOL.version &&
    typeof nonce === 'string' &&
    LIVE_NONCE.test(nonce)
    ? nonce
    : undefined;
}

/**
 * The onboarding snippet for a site the agency builds or hosts: the script tag
 * that loads the embed, and the header that lets the product, and only it,
 * frame the site. `productOrigin` is a bare https origin.
 */
export function reviewEmbedSnippet(productOrigin: string): {
  readonly script: string;
  readonly header: string;
} {
  if (!URL.canParse(productOrigin) || new URL(productOrigin).origin !== productOrigin) {
    throw new Error('the product origin is not a bare origin');
  }
  if (!productOrigin.startsWith('https://')) throw new Error('the product origin is not https');
  return {
    script: `<script src="${productOrigin}${REVIEW_EMBED_PATH}" async></script>`,
    header: `Content-Security-Policy: frame-ancestors 'self' ${productOrigin}`,
  };
}

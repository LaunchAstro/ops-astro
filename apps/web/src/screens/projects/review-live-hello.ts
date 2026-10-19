// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: one frame load's wait for the site's hello. The ping goes to
// the site origin alone, so a frame that is not (yet, or any longer) on that
// origin never sees the nonce; the hello counts only from the selected
// frame's own window, the site origin and this load's nonce, inside
// LIVE_HELLO_MS. The nonce is never rendered, stored or reported.

import {
  LIVE_HELLO_MS,
  LIVE_PROTOCOL,
  liveMessage,
} from '../../../../../packages/core-wire/src/index.ts';

/** How often the ping repeats while the site's embed may still be loading. */
const PING_EVERY_MS = 250;

/**
 * The address to frame: the review's bound page when it is an https URL with
 * no userinfo and not on the product's own origin; otherwise none.
 */
export function liveFrameAddress(pageUrl: string, productOrigin: string): URL | undefined {
  if (!URL.canParse(pageUrl)) return undefined;
  const address = new URL(pageUrl);
  const plain = address.username === '' && address.password === '';
  return address.protocol === 'https:' && plain && address.origin !== productOrigin
    ? address
    : undefined;
}

/** A fresh nonce for one frame load: 32 random bytes, base64url. */
export function freshNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/**
 * Wait for `frame`'s hello: `onLive` on the first valid one, `onExpired` when
 * none came in time. Either settles the wait; the returned stop settles it
 * with neither (a revision switch or an unmount), and nothing counts after.
 */
export function awaitHello(options: {
  readonly frame: HTMLIFrameElement;
  readonly siteOrigin: string;
  readonly nonce: string;
  /** Whether the frame has already loaded the page this wait is for. */
  readonly loaded: boolean;
  readonly onLive: () => void;
  readonly onExpired: () => void;
  /** After the hello, the frame loaded another page. */
  readonly onLeft: () => void;
}): () => void {
  const { frame, siteOrigin, nonce } = options;
  const ping = (): void => {
    frame.contentWindow?.postMessage(
      { type: LIVE_PROTOCOL.ping, version: LIVE_PROTOCOL.version, nonce },
      siteOrigin,
    );
  };
  const listen = (event: MessageEvent): void => {
    const own = frame.contentWindow;
    if (own === null || event.source !== own || event.origin !== siteOrigin) return;
    if (liveMessage(event.data, 'hello') !== nonce) return;
    stop();
    options.onLive();
  };
  const pinging = setInterval(ping, PING_EVERY_MS);
  const expiry = setTimeout(() => {
    stop();
    options.onExpired();
  }, LIVE_HELLO_MS);
  function stop(): void {
    clearInterval(pinging);
    clearTimeout(expiry);
    window.removeEventListener('message', listen);
    frame.removeEventListener('load', ping);
  }
  window.addEventListener('message', listen);
  frame.addEventListener('load', ping);
  return stop;
}

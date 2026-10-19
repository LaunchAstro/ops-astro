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

/** The ping for one load, sent to the site origin alone. */
const pinger = (frame: HTMLIFrameElement, siteOrigin: string, nonce: string) => (): void => {
  frame.contentWindow?.postMessage(
    { type: LIVE_PROTOCOL.ping, version: LIVE_PROTOCOL.version, nonce },
    siteOrigin,
  );
};

/**
 * Wait for `frame`'s hello: `onLive` on the first valid one after the frame
 * has loaded its page, `onExpired` when none came in time. After the hello,
 * any load is another page, which the hello does not cover: `onLeft`, once.
 * The returned stop ends the wait (a revision switch or an unmount), and
 * nothing counts after it.
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
  let loaded = options.loaded;
  let live = false;
  const ping = pinger(frame, siteOrigin, nonce);
  const quiet = (): void => {
    clearInterval(pinging);
    clearTimeout(expiry);
    window.removeEventListener('message', listen);
  };
  const stop = (): void => {
    quiet();
    frame.removeEventListener('load', load);
  };
  const load = (): void => {
    if (!live) {
      loaded = true;
      ping();
      return;
    }
    stop();
    options.onLeft();
  };
  const listen = (event: MessageEvent): void => {
    const own = frame.contentWindow;
    if (!loaded || own === null || event.source !== own || event.origin !== siteOrigin) return;
    if (liveMessage(event.data, 'hello') !== nonce) return;
    live = true;
    quiet();
    options.onLive();
  };
  const pinging = setInterval(ping, PING_EVERY_MS);
  const expiry = setTimeout(() => {
    stop();
    options.onExpired();
  }, LIVE_HELLO_MS);
  window.addEventListener('message', listen);
  frame.addEventListener('load', load);
  return stop;
}

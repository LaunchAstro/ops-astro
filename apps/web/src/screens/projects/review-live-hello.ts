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

/** How often the ping repeats, while waiting and while live. */
const PING_EVERY_MS = 250;

/**
 * Unanswered pings in a row after which a live frame shows another page: a
 * page on another origin never gets the ping, so it is hidden within a second.
 */
const LIVE_MISSES = 3;

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

/** A hello from the frame's own window, the site origin and this nonce. */
function isHello(
  event: MessageEvent,
  frame: HTMLIFrameElement,
  siteOrigin: string,
  nonce: string,
): boolean {
  const own = frame.contentWindow;
  if (own === null || event.source !== own || event.origin !== siteOrigin) return false;
  return liveMessage(event.data, 'hello') === nonce;
}

export interface HelloWait {
  readonly frame: HTMLIFrameElement;
  readonly siteOrigin: string;
  readonly nonce: string;
  /** Whether the frame has already loaded the page this wait is for. */
  readonly loaded: boolean;
  readonly onLive: () => void;
  readonly onExpired: () => void;
  /** After the hello, the frame shows another page (a load, or pings unanswered). */
  readonly onLeft: () => void;
}

/**
 * Wait for `frame`'s hello: `onLive` on the first valid one after the frame
 * has loaded its page, `onExpired` when none came in time. After the hello,
 * any load, or pings left unanswered, mean another page, which the hello does
 * not cover: `onLeft`, once.
 * The returned stop ends the wait (a revision switch or an unmount), and
 * nothing counts after it.
 */
export function awaitHello(options: HelloWait): () => void {
  const { frame, siteOrigin, nonce } = options;
  let loaded = options.loaded;
  let live = false;
  let unanswered = 0;
  const ping = pinger(frame, siteOrigin, nonce);
  const stop = (): void => {
    clearInterval(pinging);
    clearTimeout(expiry);
    window.removeEventListener('message', listen);
    frame.removeEventListener('load', load);
  };
  const left = (): void => {
    stop();
    options.onLeft();
  };
  const tick = (): void => {
    if (live && unanswered >= LIVE_MISSES) return left();
    if (live) unanswered += 1;
    ping();
  };
  const load = (): void => {
    if (live) return left();
    loaded = true;
    ping();
  };
  const listen = (event: MessageEvent): void => {
    if (!loaded || !isHello(event, frame, siteOrigin, nonce)) return;
    unanswered = 0;
    if (live) return;
    live = true;
    clearTimeout(expiry);
    options.onLive();
  };
  const pinging = setInterval(tick, PING_EVERY_MS);
  const expiry = setTimeout(() => {
    stop();
    options.onExpired();
  }, LIVE_HELLO_MS);
  window.addEventListener('message', listen);
  frame.addEventListener('load', load);
  return stop;
}

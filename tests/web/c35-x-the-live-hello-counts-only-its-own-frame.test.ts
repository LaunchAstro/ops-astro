// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C35-X, LF-2: the live view opens on one hello, from the selected frame's own
// window and the review's site origin, echoing this load's nonce inside three
// seconds. Everything else is ignored, and a stopped wait counts nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_HELLO_MS, LIVE_PROTOCOL } from '../../packages/core-wire/src/index.ts';
import {
  awaitHello,
  freshNonce,
  liveFrameAddress,
} from '../../apps/web/src/screens/projects/review-live-hello.ts';

const SITE = 'https://site.example';
const NONCE = 'n'.repeat(43);

const hello = (nonce: string = NONCE): unknown => ({
  type: LIVE_PROTOCOL.hello,
  version: LIVE_PROTOCOL.version,
  nonce,
});

function frame(): HTMLIFrameElement {
  const element = document.createElement('iframe');
  document.body.append(element);
  return element;
}

function send(data: unknown, origin: string, source: Window | null): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

let selected: HTMLIFrameElement;
let onLive: ReturnType<typeof vi.fn<() => void>>;
let onExpired: ReturnType<typeof vi.fn<() => void>>;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  selected = frame();
  onLive = vi.fn<() => void>();
  onExpired = vi.fn<() => void>();
  stop = awaitHello({ frame: selected, siteOrigin: SITE, nonce: NONCE, onLive, onExpired });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('C35-X the live view shows only after hello from the expected origin within 3 seconds', () => {
  it('a hello from the selected frame, the site origin and this nonce opens the live view', () => {
    send(hello(), SITE, selected.contentWindow);
    expect(onLive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_HELLO_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('no hello by 3 seconds is the fallback, and a later hello opens nothing', () => {
    vi.advanceTimersByTime(LIVE_HELLO_MS - 1);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    send(hello(), SITE, selected.contentWindow);
    expect(onLive).not.toHaveBeenCalled();
  });

  it('a stopped wait (a revision switch or an unmount) counts no hello and no timeout', () => {
    stop();
    send(hello(), SITE, selected.contentWindow);
    vi.advanceTimersByTime(LIVE_HELLO_MS * 2);
    expect(onLive).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('C35-X a message from any other origin is ignored', () => {
  it('the right frame and nonce from another origin opens nothing', () => {
    for (const origin of ['https://other.example', 'http://site.example', 'null', '']) {
      send(hello(), origin, selected.contentWindow);
    }
    expect(onLive).not.toHaveBeenCalled();
  });
});

describe('C35-X sibling frame', () => {
  it('a same-origin sibling echoing the right nonce opens nothing', () => {
    send(hello(), SITE, frame().contentWindow);
    send(hello(), SITE, window);
    send(hello(), SITE, null);
    expect(onLive).not.toHaveBeenCalled();
  });
});

describe('C35-X a malformed or foreign postMessage is ignored', () => {
  it('every malformed shape from the right frame and origin opens nothing and throws nothing', () => {
    const malformed: unknown[] = [
      hello('m'.repeat(43)),
      hello(`${NONCE}x`),
      hello('x'.repeat(100_000)),
      { ...(hello() as object), extra: '<img src=x onerror=alert(1)>' },
      { type: LIVE_PROTOCOL.hello, version: 2, nonce: NONCE },
      { type: LIVE_PROTOCOL.ping, version: LIVE_PROTOCOL.version, nonce: NONCE },
      { type: LIVE_PROTOCOL.hello, nonce: NONCE },
      JSON.stringify(hello()),
      [LIVE_PROTOCOL.hello, LIVE_PROTOCOL.version, NONCE],
      Object.assign(Object.create({ type: LIVE_PROTOCOL.hello }) as object, {
        version: LIVE_PROTOCOL.version,
        nonce: NONCE,
      }),
      null,
      undefined,
      42,
    ];
    const own = selected.contentWindow;
    for (const data of malformed) expect(() => send(data, SITE, own)).not.toThrow();
    expect(onLive).not.toHaveBeenCalled();
  });
});

describe('C35-X the framed address', () => {
  const PRODUCT = 'https://ops.example.com';

  it('is the bound https page, with no userinfo, and never the product itself', () => {
    expect(liveFrameAddress('https://site.example/about?a=1', PRODUCT)?.href).toBe(
      'https://site.example/about?a=1',
    );
    for (const refused of [
      'http://site.example/about',
      `https://user:secret${'@'}site.example/about`,
      `https://user${'@'}site.example/about`,
      'https://ops.example.com/tasks',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'blob:https://site.example/1',
      '/relative',
      'not a url',
    ]) {
      expect(liveFrameAddress(refused, PRODUCT), refused).toBeUndefined();
    }
  });

  it('each load gets a fresh, unguessable nonce', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => freshNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[\w-]{43}$/u);
  });
});

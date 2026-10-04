// SPDX-License-Identifier: AGPL-3.0-only
//
// The capture's picture: a screenshot of one catalogued page, taken by a
// browser whose every request is answered here, through the fence, or refused.
// The browser itself is a port (the worker supplies it); what it may load is
// decided in this file and nowhere else:
//
// - the page's own document, fetched by the fence as a document once (a reload
//   is refused), served with a policy that runs no script, loads no frame,
//   object or worker, whatever the browser was told; where the fence followed a
//   redirect, the browser is redirected too and served the copy at the final
//   address, so it resolves the page's addresses as the page observation does;
// - its stylesheets, fetched by the fence as stylesheets of that page, each
//   once (a repeat is answered from the first fetch), a few at a time and no
//   more distinct ones than the page observation allows; one that cannot be
//   fetched fails the picture, as it fails the page observation;
// - nothing else: images, fonts, scripts, frames and any other request are
//   refused and recorded by code and origin only, never a path or query.
//
// No credential reaches the browser: the fence sends none. Nor has the browser
// a network of its own: a preconnect or DNS prefetch makes no request the
// route could refuse, so the port starts it with PICTURE_BROWSER_ARGS.

import { createHash } from 'node:crypto';
import {
  MAX_STYLESHEETS,
  SHEETS_AT_ONCE,
  fencedFetch,
  limiter,
  type FenceCode,
  type FenceRefusal,
  type Fenced,
  type Fetched,
} from './fence.ts';
import type { CaptureOptions } from './page.ts';

/** One request the browser made, as the port describes it. */
export interface PictureRequest {
  readonly url: string;
  /** The browser's resource type: `document`, `stylesheet`, `image`, `script` and so on. */
  readonly kind: string;
  /** Whether it is the top-level navigation, not a frame inside the page. */
  readonly mainFrame: boolean;
}

export interface PictureAnswer {
  /**
   * 200 with the body, or 302 (the body empty) to the address the fence's fetch ended at: the
   * port follows it, handing that request to the route too.
   */
  readonly status: 200 | 302;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers one browser request, or null to refuse it. */
export type PictureRoute = (request: PictureRequest) => Promise<PictureAnswer | null>;

/**
 * Loads `url` with every request handed to `route`, and returns the PNG it rendered. The
 * browser has no network of its own: it is started with PICTURE_BROWSER_ARGS.
 */
export type PictureBrowser = (url: string, route: PictureRoute) => Promise<Uint8Array>;

/**
 * The picture browser's launch arguments: no name resolves, and every connection goes to a
 * proxy that refuses it, loopback included, so a hint the route never sees reaches nothing.
 */
export const PICTURE_BROWSER_ARGS: readonly string[] = [
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
];

export interface Picture {
  readonly url: string;
  readonly digest: string;
  readonly png: Uint8Array;
  /** What the browser asked for and was refused, by code and origin. */
  readonly refused: readonly FenceRefusal[];
}

/** The document's policy: markup, the fenced stylesheets and data: images render, nothing else loads. */
export const PICTURE_POLICY: string =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; script-src 'none'; " +
  "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'";

const originOf = (url: string): string => (URL.canParse(url) ? new URL(url).origin : '');
const DOCUMENT = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PICTURE_POLICY,
};

interface RouteState {
  readonly refused: FenceRefusal[];
  /** Each sheet's fenced answer, by address: a repeat is answered from it. */
  readonly sheets: Map<string, Promise<Fenced<Fetched>>>;
  /** Fetched answers the browser was redirected to, by kind and final address. */
  readonly moved: Map<string, Fetched>;
  served: boolean;
  failed: FenceCode | undefined;
}

/** The fetched copy, served where it was fetched; if it moved, the browser is sent there first. */
function answered(
  state: RouteState,
  request: PictureRequest,
  fetched: Fetched,
  headers: Readonly<Record<string, string>>,
): PictureAnswer {
  if (fetched.url === request.url) return { status: 200, headers, body: fetched.body };
  state.moved.set(`${request.kind} ${fetched.url}`, fetched);
  return { status: 302, headers: { location: fetched.url }, body: '' };
}

function pictureRoute(page: string, options: CaptureOptions, state: RouteState): PictureRoute {
  const record = (refusal: FenceRefusal) => {
    state.refused.push(refusal);
    options.record?.(refusal);
  };
  const fenced = { ...options, record };
  const run = limiter(SHEETS_AT_ONCE);
  return async (request) => {
    const key = `${request.kind} ${request.url}`;
    const landed = state.moved.get(key);
    if (request.kind === 'document' && request.mainFrame && landed !== undefined) {
      state.moved.delete(key);
      return answered(state, request, landed, DOCUMENT);
    }
    if (request.kind === 'document' && request.mainFrame && request.url === page) {
      if (state.served) {
        record({ code: 'CAPTURE_KIND_REFUSED', hop: 0, origin: originOf(page) });
        return null;
      }
      state.served = true;
      const fetched = await fencedFetch(page, { ...fenced, kind: 'document' });
      if (!fetched.ok) {
        state.failed ??= fetched.code;
        return null;
      }
      return answered(state, request, fetched.value, DOCUMENT);
    }
    if (request.kind === 'stylesheet') {
      if (!state.sheets.has(request.url) && state.sheets.size >= MAX_STYLESHEETS) {
        state.failed ??= 'CAPTURE_OVERSIZED';
        record({ code: 'CAPTURE_OVERSIZED', hop: 0, origin: originOf(request.url) });
        return null;
      }
      const cached = state.sheets.get(request.url);
      const fetching =
        cached ?? run(() => fencedFetch(request.url, { ...fenced, kind: 'stylesheet', page }));
      state.sheets.set(request.url, fetching);
      const sheet = await fetching;
      if (!sheet.ok) {
        state.failed ??= sheet.code;
        return null;
      }
      const headers = { 'content-type': 'text/css; charset=utf-8' };
      return { status: 200, headers, body: sheet.value.body };
    }
    record({ code: 'CAPTURE_KIND_REFUSED', hop: 0, origin: originOf(request.url) });
    return null;
  };
}

/** One picture of a catalogued page, every request through the fence. */
export async function capturePicture(
  url: string,
  options: CaptureOptions,
  browser: PictureBrowser,
): Promise<Fenced<Picture>> {
  const state: RouteState = {
    refused: [],
    sheets: new Map(),
    moved: new Map(),
    served: false,
    failed: undefined,
  };
  let png: Uint8Array;
  try {
    png = await browser(url, pictureRoute(url, options, state));
  } catch {
    return { ok: false, code: state.failed ?? 'CAPTURE_FAILED' };
  }
  if (state.failed !== undefined) return { ok: false, code: state.failed };
  const digest = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  return { ok: true, value: { url, digest, png, refused: state.refused } };
}

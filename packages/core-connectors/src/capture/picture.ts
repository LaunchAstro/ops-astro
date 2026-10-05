// SPDX-License-Identifier: AGPL-3.0-only
//
// The capture's picture: a screenshot of one catalogued page, taken by a
// browser whose every request is answered here, through the fence, or refused.
// The browser itself is a port (the worker supplies it); what it may load is
// decided in this file and nowhere else:
//
// - the page's own document, fetched by the fence as a document before the
//   browser starts: the browser opens the address the fetch ended at and is
//   served that copy there, once (a reload is refused), so it resolves the
//   page's addresses as the page observation does, with a policy that runs no
//   script, loads no frame, object or worker, whatever the browser was told;
// - its stylesheets, fetched by the fence as stylesheets of that page, each
//   once (a repeat is answered from the first fetch), a few at a time and no
//   more distinct ones than the page observation allows; one that cannot be
//   fetched fails the picture, as it fails the page observation; each is
//   answered with an import of its copy, served unchanged at the address the
//   fence's fetch ended at with a query only this capture knows added, so its
//   own imports resolve as the page observation resolves them (a browser hands a
//   sheet's redirect to no route);
// - nothing else: images, fonts, scripts, frames and any other request are
//   refused and recorded by code and origin only, never a path or query.
//
// The picture holds only where the browser applied every sheet the page observation
// reads (the page names it, or a copy served imports it), not the sheets the browser
// asked for: each must reach the route, and each answer's import must be asked for,
// which a browser does only once it has accepted the answer. A sheet blocked before
// the route (a policy in the markup, mixed content) or rejected after it (a failed
// integrity check) leaves one unasked, and the picture fails. So does an import a
// browser skips (one after a rule, or under a condition it does not support): the
// observation read a sheet the picture would lack.
//
// No credential reaches the browser: the fence sends none. Nor has the browser
// a network of its own: a preconnect or DNS prefetch makes no request the
// route could refuse, so the port starts it with PICTURE_BROWSER_ARGS.

import { createHash, randomUUID } from 'node:crypto';
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
import { importsOf, named, readDocument, resolved, type CaptureOptions } from './page.ts';

/** One request the browser made, as the port describes it. */
export interface PictureRequest {
  readonly url: string;
  /** The browser's resource type: `document`, `stylesheet`, `image`, `script` and so on. */
  readonly kind: string;
  /** Whether it is the top-level navigation, not a frame inside the page. */
  readonly mainFrame: boolean;
}

export interface PictureAnswer {
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers one browser request, or null to refuse it. */
export type PictureRoute = (request: PictureRequest) => Promise<PictureAnswer | null>;

/**
 * Loads `url` (the address the fence's fetch of the page ended at) with every request handed to
 * `route`, and returns the PNG it rendered. The browser has no network of its own: it is started
 * with PICTURE_BROWSER_ARGS.
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

/**
 * The document's policy: markup, the fenced stylesheets and data: images render, nothing else
 * loads. Any https sheet may load, so every sheet request reaches the route and the fence alone
 * decides it. A `<base>` is honoured, as the page observation honours it: every address it moves
 * is still answered through the route, so one the fence refuses fails the picture.
 */
export const PICTURE_POLICY: string =
  "default-src 'none'; style-src https: 'unsafe-inline'; img-src data:; script-src 'none'; " +
  "object-src 'none'; frame-src 'none'; worker-src 'none'";

const originOf = (url: string): string => (URL.canParse(url) ? new URL(url).origin : '');
const STYLESHEET = { 'content-type': 'text/css; charset=utf-8' };
const DOCUMENT = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PICTURE_POLICY,
};

interface RouteState {
  readonly refused: FenceRefusal[];
  /** Every stylesheet address the browser asked for. */
  readonly asked: Set<string>;
  /** Each sheet's fenced answer, by address: a repeat is answered from it. */
  readonly sheets: Map<string, Promise<Fenced<Fetched>>>;
  /** Each sheet's copy, by the address its answer imports it from. */
  readonly copies: Map<string, Fetched>;
  /** Copies' addresses not yet asked for: the browser asks only once it accepts the answer. */
  readonly owed: Set<string>;
  /** Every sheet the page observation reads: named by the page or imported by a copy served. */
  readonly read: (string | undefined)[];
  /** The query that marks a copy's address: random, so no page can know it. */
  readonly mark: string;
  served: boolean;
  failed: FenceCode | undefined;
}

/** A sheet, answered with an import of its copy: where the fence's fetch ended, and marked. */
function answered(state: RouteState, fetched: Fetched): PictureAnswer {
  const copy = new URL(fetched.url);
  [copy.search, copy.hash] = [`${copy.search}&${state.mark}`, ''];
  state.copies.set(copy.href, fetched);
  if (!state.asked.has(copy.href)) state.owed.add(copy.href);
  const body = `@import "${copy.href.replaceAll('\\', '\\\\')}";`;
  return { status: 200, headers: STYLESHEET, body };
}

function pictureRoute(
  page: string,
  document: Fetched,
  fenced: CaptureOptions,
  state: RouteState,
): PictureRoute {
  const run = limiter(SHEETS_AT_ONCE);
  return async (request) => {
    const main = request.kind === 'document' && request.mainFrame;
    if (main && request.url === document.url && !state.served) {
      state.served = true;
      return { status: 200, headers: DOCUMENT, body: document.body };
    }
    if (request.kind === 'stylesheet') {
      state.asked.add(request.url);
      state.owed.delete(request.url);
      const copy = state.copies.get(request.url);
      if (copy !== undefined) {
        for (const href of importsOf(copy.body)) state.read.push(resolved(href, copy.url));
        return { status: 200, headers: STYLESHEET, body: copy.body };
      }
      if (!state.sheets.has(request.url) && state.sheets.size >= MAX_STYLESHEETS) {
        state.failed ??= 'CAPTURE_OVERSIZED';
        fenced.record?.({ code: 'CAPTURE_OVERSIZED', hop: 0, origin: originOf(request.url) });
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
      return answered(state, sheet.value);
    }
    fenced.record?.({ code: 'CAPTURE_KIND_REFUSED', hop: 0, origin: originOf(request.url) });
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
    asked: new Set(),
    sheets: new Map(),
    copies: new Map(),
    owed: new Set(),
    read: [],
    mark: `picture-${randomUUID()}`,
    served: false,
    failed: undefined,
  };
  const record = (refusal: FenceRefusal) => {
    state.refused.push(refusal);
    options.record?.(refusal);
  };
  const fenced = { ...options, record };
  const page = await fencedFetch(url, { ...fenced, kind: 'document' });
  if (!page.ok) return page;
  const reading = readDocument(page.value.body);
  if (typeof reading === 'string') return { ok: false, code: reading };
  state.read.push(...named(reading, page.value.url));
  let png: Uint8Array;
  try {
    png = await browser(page.value.url, pictureRoute(url, page.value, fenced, state));
  } catch {
    return { ok: false, code: state.failed ?? 'CAPTURE_FAILED' };
  }
  const unapplied = state.owed.size > 0 || state.read.some((href) => !state.asked.has(href ?? ''));
  state.failed ??= unapplied ? 'CAPTURE_FAILED' : undefined;
  if (state.failed !== undefined) return { ok: false, code: state.failed };
  const digest = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  return { ok: true, value: { url, digest, png, refused: state.refused } };
}

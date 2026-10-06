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
// observation read a sheet the picture would lack. An `http-equiv` in the page's own
// markup (a policy, a default set, a refresh), a style of another type, or a titled or
// alternate sheet can leave out a sheet the observation read, or the page itself, with no
// request to show it, so such a page is refused before the browser starts. Each copy is
// served as UTF-8, so a sheet a browser would decode otherwise fails the picture, as it
// fails the page observation.
//
// No credential reaches the browser: the fence sends none. Nor has the browser
// a network of its own: a preconnect or DNS prefetch makes no request the
// route could refuse, so the port starts it with PICTURE_BROWSER_ARGS.

import { createHash, randomUUID } from 'node:crypto';
import type { DefaultTreeAdapterTypes as Tree } from 'parse5';
import {
  MAX_STYLESHEETS,
  SHEETS_AT_ONCE,
  fencedFetch,
  isUtf8Label,
  limiter,
  type FenceCode,
  type FenceRefusal,
  type Fenced,
  type Fetched,
} from './fence.ts';
import { importsOf, named, readDocument, resolved, type CaptureOptions } from './page.ts';
import { admittedTree } from './tree.ts';

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

const CHARSET = '@charset "';

/**
 * Whether a browser decodes this fenced sheet as UTF-8, read in its order: the fence passed no
 * BOM but UTF-8's and no header charset but UTF-8, so a `@charset` rule decides, and with none
 * the page's (or the importing sheet's) UTF-8 does. A rule naming anything but UTF-8, or one CSS
 * might read otherwise than here, is refused: the header it would lose to is not kept.
 */
function readsAsUtf8(css: string): boolean {
  if (!css.startsWith(CHARSET)) return true;
  const end = css.indexOf('";', CHARSET.length);
  const label = css.slice(CHARSET.length, end);
  return end > 0 && !label.includes('"') && isUtf8Label(label);
}

const lower = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
// The `http-equiv` values that leave the picture as the observation read the page: the fence
// holds the charset, a language or compatibility mode moves no sheet, the picture's browser has
// no network to prefetch on, and a browser ignores a report-only policy and cache headers in
// markup. Any other is refused: a policy can drop a sheet, a default set chooses among titled
// ones, a refresh navigates away from the page pictured, and an unknown one is not guessed at.
const PICTURED_EQUIV = new Set([
  '',
  'content-type',
  'content-language',
  'x-ua-compatible',
  'content-security-policy-report-only',
  'x-dns-prefetch-control',
  'cache-control',
  'pragma',
  'expires',
]);

/**
 * Whether a browser could leave out a sheet the observation reads, with no request to show it:
 * an `http-equiv` other than those, a style of a type other than CSS, or a titled or
 * alternate sheet (of titled sets a browser applies only the preferred one). Only the forms a
 * browser always applies pass.
 */
function mayDropSheet(document: Tree.Document): boolean {
  const stack: Tree.Node[] = [document];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    // One at a time: a wide node's children spread into one call pass the argument limit.
    if ('childNodes' in node) for (const child of node.childNodes) stack.push(child);
    if (!('attrs' in node)) continue;
    const attribute = (name: string) => node.attrs.find((one) => one.name === name)?.value;
    const titled = (attribute('title') ?? '') !== '';
    const rel = lower(attribute('rel') ?? '').split(/[\t\n\f\r ]+/u);
    if (node.tagName === 'meta' && !PICTURED_EQUIV.has(lower(attribute('http-equiv') ?? '').trim()))
      return true;
    if (
      node.tagName === 'style' &&
      (titled || !['', 'text/css'].includes(lower(attribute('type') ?? '')))
    )
      return true;
    if (
      node.tagName === 'link' &&
      rel.includes('stylesheet') &&
      (titled || rel.includes('alternate'))
    )
      return true;
  }
  return false;
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
      if (!sheet.ok || !readsAsUtf8(sheet.value.body)) {
        state.failed ??= sheet.ok ? 'CAPTURE_BODY_MALFORMED' : sheet.code;
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
  // The reading held the markup within the capture's bounds, so its tree is built once more in them.
  if (mayDropSheet(admittedTree(page.value.body)))
    return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
  for (const href of named(reading, page.value.url)) state.read.push(href);
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

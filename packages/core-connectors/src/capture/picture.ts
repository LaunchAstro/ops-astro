// SPDX-License-Identifier: AGPL-3.0-only
//
// The capture's picture: a screenshot of one catalogued page, taken by a
// browser whose every request is answered here, through the fence, or refused.
// The browser itself is a port (the worker supplies it); what it may load is
// decided in this file and nowhere else:
//
// - the page's own document, fetched by the fence as a document, served with a
//   policy that runs no script, loads no frame, object or worker, whatever the
//   browser was told;
// - its stylesheets, fetched by the fence as stylesheets of that page; one that
//   cannot be fetched fails the picture, as it fails the page observation;
// - nothing else: images, fonts, scripts, frames and any other request are
//   refused and recorded by code and origin only, never a path or query.
//
// No credential reaches the browser: the fence sends none.

import { createHash } from 'node:crypto';
import { fencedFetch, type FenceCode, type FenceRefusal, type Fenced } from './fence.ts';
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
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers one browser request, or undefined to refuse it. */
export type PictureRoute = (request: PictureRequest) => Promise<PictureAnswer | undefined>;

/** Loads `url` with every request handed to `route`, and returns the PNG it rendered. */
export type PictureBrowser = (url: string, route: PictureRoute) => Promise<Uint8Array>;

export interface Picture {
  readonly url: string;
  readonly digest: string;
  readonly png: Uint8Array;
  /** What the browser asked for and was refused, by code and origin. */
  readonly refused: readonly FenceRefusal[];
}

/** The document's policy: markup and the fenced stylesheets render, nothing executes. */
export const PICTURE_POLICY =
  "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'";

interface RouteState {
  readonly refused: FenceRefusal[];
  failed: FenceCode | undefined;
}

/** Stub: every request fetched as a document, no policy. */
function pictureRoute(_page: string, options: CaptureOptions, _state: RouteState): PictureRoute {
  return async (request) => {
    const fetched = await fencedFetch(request.url, { ...options, kind: 'document' });
    if (!fetched.ok) return undefined;
    return { status: 200, headers: { 'content-type': 'text/html' }, body: fetched.value.body };
  };
}

/** One picture of a catalogued page, every request through the fence. */
export async function capturePicture(
  url: string,
  options: CaptureOptions,
  browser: PictureBrowser,
): Promise<Fenced<Picture>> {
  const state: RouteState = { refused: [], failed: undefined };
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

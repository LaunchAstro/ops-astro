// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: the review embed, the script an agency-built site loads so the
// review workspace may show it live. It answers a ping only from the product
// origin it was loaded from, and only from the window framing the page, with
// a hello echoing the ping's nonce to that origin alone. It reads nothing of
// the page and sends nothing else.

import type { Hono } from 'hono';
import {
  LIVE_NONCE,
  LIVE_PROTOCOL,
  REVIEW_EMBED_PATH,
} from '../../packages/core-wire/src/index.ts';

export const REVIEW_EMBED_SCRIPT: string = `(function () {
  var script = document.currentScript;
  if (!script || window.parent === window) return;
  var product = new URL(script.src).origin;
  var nonce = ${String(LIVE_NONCE)};
  addEventListener('message', function (event) {
    var data = event.data;
    if (event.origin !== product || event.source !== window.parent) return;
    if (!data || typeof data !== 'object' || Object.getPrototypeOf(data) !== Object.prototype) return;
    if (Object.keys(data).length !== 3 || data.type !== ${JSON.stringify(LIVE_PROTOCOL.ping)}) return;
    if (data.version !== ${String(LIVE_PROTOCOL.version)} || typeof data.nonce !== 'string' || !nonce.test(data.nonce)) return;
    window.parent.postMessage(
      { type: ${JSON.stringify(LIVE_PROTOCOL.hello)}, version: ${String(LIVE_PROTOCOL.version)}, nonce: data.nonce },
      product
    );
  });
})();
`;

/** The embed, with no sign-in: a script any site may load, never sniffed as anything else. */
export function mountReviewEmbed(api: Hono): void {
  api.get(REVIEW_EMBED_PATH, (context) =>
    context.body(REVIEW_EMBED_SCRIPT, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    }),
  );
}

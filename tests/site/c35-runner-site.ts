// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's review captures (#2013), the parts that reach no database: the agency's
// about page, the fence's pool on it, and a replay of the page behind the fence's transport.
// Suites that test the runner's pass alone import these from here, so they stay out of the
// database harness (tests/db/named-suite-manifest.test.ts); c35-runner-world.ts re-exports them.

import type {
  CapturePool,
  Transport,
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';
import { PAGE } from './c80-sites.ts';
import { CSS, PAGE as PAGE_HTML, publicResolver } from './c80-picture-world.ts';

export { PAGE, publicResolver };

/** The agency's about page and its stylesheet, as the replay serves them. */
export const SHEET: string = new URL('/_astro/site.css', PAGE).href;

/** The fence's pool on the agency's own site: its about page alone. */
export const AGENCY_POOL: CapturePool = {
  agencyPages: [PAGE],
  otherPages: [],
  closedPoolReviews: [],
};

const answer = (type: string, body: string): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});

const MISSING: TransportAnswer = {
  kind: 'answer',
  status: 404,
  headers: {},
  body: new Uint8Array(),
};

/** The agency's about page and its stylesheet, as the replay serves them unless told otherwise. */
const ABOUT_SITE: Readonly<Record<string, TransportAnswer>> = {
  [PAGE]: answer('text/html; charset=utf-8', PAGE_HTML),
  [SHEET]: answer('text/css', CSS),
};

/** The replay site: every request it is asked, and the pages it serves. */
export function replay(
  pages: Readonly<Record<string, TransportAnswer>> = ABOUT_SITE,
): Transport & { readonly asked: TransportRequest[] } {
  const asked: TransportRequest[] = [];
  const transport = (request: TransportRequest) => {
    asked.push(request);
    return Promise.resolve(pages[request.url.href] ?? MISSING);
  };
  return Object.assign(transport, { asked });
}

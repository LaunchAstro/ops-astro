// SPDX-License-Identifier: AGPL-3.0-only
//
// The site the picture tests capture: one catalogued page and its stylesheet,
// served by a transport double that counts every request, with a page that
// asks for everything the fence must refuse (an inline and a linked script,
// an image on another host, a frame).

import type {
  CapturePool,
  Transport,
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

export const ABOUT = 'https://www.example.com/about';
export const SHEET = 'https://www.example.com/_astro/site.css';
export const TRACKER = 'https://tracker.example.net/pixel.png?who=visitor';
export const POOL: CapturePool = { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] };

export const PAGE: string = `<!doctype html><html><head>
<link rel="stylesheet" href="/_astro/site.css">
<script>document.documentElement.dataset.ran = 'yes';</script>
</head><body>
<p>We are a welcoming studio.</p>
<img src="${TRACKER}" alt="">
<iframe src="${ABOUT}"></iframe>
<script src="/_astro/app.js"></script>
</body></html>`;

export const CSS = 'p { font: 16px serif; color: rgb(20, 20, 20); }';

function answer(type: string, body: string): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': type },
    body: new TextEncoder().encode(body),
  };
}

const MISSING: TransportAnswer = {
  kind: 'answer',
  status: 404,
  headers: {},
  body: new Uint8Array(),
};

/** The site, with the stylesheet present or answering 404. */
export function site(sheet = true): Transport & {
  seen: string[];
} {
  const pages: Record<string, TransportAnswer> = {
    [ABOUT]: answer('text/html', PAGE),
    ...(sheet ? { [SHEET]: answer('text/css', CSS) } : {}),
  };
  const seen: string[] = [];
  const transport = (request: TransportRequest) => {
    seen.push(request.url.href);
    return Promise.resolve(pages[request.url.href] ?? MISSING);
  };
  return Object.assign(transport, { seen });
}

export const publicResolver = (): Promise<string[]> => Promise.resolve(['93.184.215.14']);

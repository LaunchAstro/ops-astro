// SPDX-License-Identifier: AGPL-3.0-only
//
// No other site may frame a page. The page's content policy is a `<meta>`
// (index.html), which cannot carry `frame-ancestors`, so the refusal goes on
// the response wherever a page is served: the hosted build output's routes
// (`scripts/ops/release.ts`) and the dev and preview servers (`vite.config.ts`).
// `X-Frame-Options` is the same refusal for a browser that predates
// `frame-ancestors`.

export const FRAMING_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

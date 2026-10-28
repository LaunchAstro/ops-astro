// SPDX-License-Identifier: AGPL-3.0-only
//
// What a `meta` tag in a page's own markup can do to the page's picture: an `http-equiv` that a
// browser honours there can leave out a sheet the page observation read, with no request to show
// it, so the picture (picture.ts) refuses such a page before its browser starts.

const lower = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

// The `http-equiv` values that leave the picture as the observation read the page: the fence
// holds the charset, a language or compatibility mode moves no sheet, the picture's browser has
// no network to prefetch on, and a browser ignores a report-only policy and cache headers in
// markup. A policy is judged by its directives (STYLE_DIRECTIVES). Any other is refused: a
// default set chooses among titled sheets, a refresh navigates away from the page pictured, and
// an unknown one is not guessed at.
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

// The directives under which a policy can block an inline sheet or a style attribute, which no
// request shows; `default-src` stands in for each that is absent. A sheet any other directive
// blocks never reaches the picture's route, so it is left unasked and the picture fails.
const STYLE_DIRECTIVES = new Set(['default-src', 'style-src', 'style-src-elem', 'style-src-attr']);

/** Whether a markup policy names a style source: any directive, in any policy of a list. */
const namesStyleSource = (policy: string): boolean =>
  policy
    .split(/[;,]/u)
    .some((directive) => STYLE_DIRECTIVES.has(lower(directive.trim().split(/\s/u)[0] ?? '')));

/** Whether a `meta` tag with this `http-equiv` and `content` could leave out a sheet. */
export function metaMayDropSheet(equiv: string | undefined, content: string | undefined): boolean {
  const name = lower(equiv ?? '').trim();
  return name === 'content-security-policy'
    ? namesStyleSource(content ?? '')
    : !PICTURED_EQUIV.has(name);
}

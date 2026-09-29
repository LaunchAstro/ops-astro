// SPDX-License-Identifier: AGPL-3.0-only
//
// One fenced capture of a catalogued page, as the observation Receipt L
// compares (fields 9 to 12): the page's visible text, the document's digest,
// and the digest of every stylesheet it serves, linked or inline. Every fetch
// goes through the fence. A linked stylesheet that cannot be fetched fails the
// whole capture: dropping it would let "the stylesheets are unchanged" pass
// over a stylesheet nobody looked at.

import { createHash } from 'node:crypto';
import type { PageObservation } from '../site/envelope.ts';
import { fencedFetch, type FetchOptions, type Fenced } from './fence.ts';

export type CaptureOptions = Omit<FetchOptions, 'kind' | 'page'>;

const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** A code point a page may name; anything else stays as written rather than throwing. */
function codePoint(code: number, whole: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff
    ? String.fromCodePoint(code)
    : whole;
}

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
    if (/^#x/iu.test(name)) return codePoint(Number(`0x${name.slice(2)}`), whole);
    if (name.startsWith('#')) return codePoint(Number(name.slice(1)), whole);
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The text a reader sees: no comments, scripts, styles, fallbacks or markup. */
export function visibleText(html: string): string {
  const stripped = html
    .replaceAll(/<!--[\s\S]*?-->/gu, ' ')
    .replaceAll(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replaceAll(/<[^>]*>/gu, ' ');
  return decodeEntities(stripped).replaceAll(/\s+/gu, ' ').trim();
}

// One literal pattern per attribute read, so no expression is built from a string.
const ATTRIBUTES = {
  rel: /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu,
  href: /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu,
} as const;

function attribute(tag: string, name: keyof typeof ATTRIBUTES): string | undefined {
  const found = ATTRIBUTES[name].exec(tag);
  return found === null ? undefined : (found[1] ?? found[2] ?? found[3]);
}

/** Every `<link>` whose rel names a stylesheet, as written. */
function stylesheetLinks(html: string): string[] {
  const links: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u);
    const href = attribute(tag, 'href');
    if (rel.includes('stylesheet') && href !== undefined) links.push(href);
  }
  return links;
}

function inlineStyles(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(
    (match) => match[1] ?? '',
  );
}

export async function capturePage(
  url: string,
  options: CaptureOptions,
): Promise<Fenced<PageObservation>> {
  const page = await fencedFetch(url, { ...options, kind: 'document' });
  if (!page.ok) return page;
  const html = page.value.body;
  const hrefs = stylesheetLinks(html).map((href) =>
    URL.canParse(href, page.value.url) ? new URL(href, page.value.url).href : undefined,
  );
  if (hrefs.includes(undefined)) return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
  const unique = [...new Set(hrefs as string[])];
  const fetched = await Promise.all(
    unique.map((href) => fencedFetch(href, { ...options, kind: 'stylesheet', page: url })),
  );
  const stylesheets: Record<string, string> = {};
  for (const [index, sheet] of fetched.entries()) {
    if (!sheet.ok) return sheet;
    stylesheets[unique[index] ?? ''] = digest(sheet.value.body);
  }
  for (const [index, css] of inlineStyles(html).entries())
    stylesheets[`inline:${index}`] = digest(css);
  const sorted = Object.fromEntries(
    Object.entries(stylesheets).toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
  return {
    ok: true,
    value: {
      url: page.value.url,
      status: page.value.status,
      documentDigest: digest(html),
      text: visibleText(html),
      stylesheets: sorted,
    },
  };
}

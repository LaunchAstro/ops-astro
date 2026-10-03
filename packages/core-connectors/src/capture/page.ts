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

// One pass, left to right, by index: no pattern runs from an opener to a
// closer, so a page that never closes costs one read of it, not one read per
// opener. Tag names are matched as HTML matches them, by ASCII case only.
// A comment, raw-text element or tag that never closes makes the page
// malformed; a `<` that cannot start one is text, as a browser reads it.
const RAW_TEXT = ['script', 'style', 'noscript', 'template'] as const;

interface Document {
  readonly text: string;
  readonly links: readonly string[];
  readonly styles: readonly string[];
}

function asciiLower(html: string): string {
  return html.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function nameAt(lower: string, at: number, name: string): boolean {
  return lower.startsWith(name, at) && !/[a-z0-9_-]/u.test(lower.charAt(at + name.length));
}

/** Where `</name>` (spaces allowed before `>`) ends after `from`, or -1. */
function closerEnd(lower: string, name: string, from: number): number {
  for (let at = lower.indexOf(`</${name}`, from); at !== -1;) {
    let end = at + name.length + 2;
    while (/\s/u.test(lower.charAt(end))) end += 1;
    if (lower.charAt(end) === '>') return end + 1;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return -1;
}

function linkHref(tag: string): string | undefined {
  const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u);
  return rel.includes('stylesheet') ? attribute(tag, 'href') : undefined;
}

function readDocument(html: string): Document | undefined {
  const lower = asciiLower(html);
  const text: string[] = [];
  const links: string[] = [];
  const styles: string[] = [];
  let at = 0;
  for (let open = lower.indexOf('<'); open !== -1; open = lower.indexOf('<', at)) {
    const next = lower.charAt(open + 1);
    if (!/[a-z/!?]/u.test(next)) {
      text.push(html.slice(at, open + 1));
      at = open + 1;
      continue;
    }
    text.push(html.slice(at, open), ' ');
    const raw = RAW_TEXT.find((name) => nameAt(lower, open + 1, name));
    if (lower.startsWith('<!--', open)) {
      const end = lower.indexOf('-->', open + 4);
      if (end === -1) return undefined;
      at = end + 3;
    } else if (raw === undefined) {
      const end = lower.indexOf('>', open);
      if (end === -1) return undefined;
      const tag = html.slice(open, end + 1);
      const href = nameAt(lower, open + 1, 'link') ? linkHref(tag) : undefined;
      if (href !== undefined) links.push(href);
      at = end + 1;
    } else {
      const start = lower.indexOf('>', open);
      const end = start === -1 ? -1 : closerEnd(lower, raw, start + 1);
      if (end === -1) return undefined;
      if (raw === 'style') styles.push(html.slice(start + 1, lower.lastIndexOf('</', end)));
      at = end;
    }
  }
  text.push(html.slice(at));
  return { text: decodeEntities(text.join('')).replaceAll(/\s+/gu, ' ').trim(), links, styles };
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

export async function capturePage(
  url: string,
  options: CaptureOptions,
): Promise<Fenced<PageObservation>> {
  const page = await fencedFetch(url, { ...options, kind: 'document' });
  if (!page.ok) return page;
  const html = page.value.body;
  const document = readDocument(html);
  if (document === undefined) return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
  const hrefs = document.links.map((href) =>
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
  for (const [index, css] of document.styles.entries())
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
      text: document.text,
      stylesheets: sorted,
    },
  };
}

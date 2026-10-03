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
import {
  MAX_STYLESHEETS,
  SHEETS_AT_ONCE,
  fencedFetch,
  limiter,
  type FetchOptions,
  type Fenced,
} from './fence.ts';

export type CaptureOptions = Omit<FetchOptions, 'kind' | 'page'>;

const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// Named references this capture reads, by exact name, as HTML matches them.
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['AMP', '&'],
  ['lt', '<'],
  ['LT', '<'],
  ['gt', '>'],
  ['GT', '>'],
  ['quot', '"'],
  ['QUOT', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['Tab', '\t'],
  ['NewLine', '\n'],
]);

/** A code point a reference may name, else as written; C1 codes too (a browser reads windows-1252). */
function codePoint(code: number, whole: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff && (code < 0x80 || code > 0x9f)
    ? String.fromCodePoint(code)
    : whole;
}

/**
 * Decodes references as a browser does. `unsure` hears of a named one this table cannot read
 * that a browser might: one ending in `;`, or one not followed by `=`.
 */
function decodeReferences(text: string, unsure?: () => void): string {
  return text.replaceAll(
    /&(?:#x([0-9a-f]+);?|#([0-9]+);?|([a-z0-9]+)(;?))/giu,
    (whole: string, hex?: string, decimal?: string, name = '', end = '', offset = 0) => {
      if (hex !== undefined) return codePoint(Number(`0x${hex}`), whole);
      if (decimal !== undefined) return codePoint(Number(decimal), whole);
      const known = end === ';' ? ENTITIES.get(name) : undefined;
      if (known === undefined && (end === ';' || text.charAt(offset + whole.length) !== '=')) {
        unsure?.();
      }
      return known ?? whole;
    },
  );
}

/** An address attribute as a browser reads it, or undefined where a reference makes it unsure. */
function addressValue(raw: string): string | undefined {
  let sure = true;
  const value = decodeReferences(raw, () => {
    sure = false;
  });
  return sure ? value : undefined;
}

// One pass, left to right, by index, following the HTML tokenizer's states for
// comments, tags, attributes and raw text: no pattern runs from an opener to a
// closer, so a page that never closes costs one read of it, not one read per
// opener. Tag names are matched as HTML matches them, by ASCII case only. A
// comment, raw-text element or tag that never closes makes the page malformed;
// a `<` that cannot start one is text, as a browser reads it.
//
// Elements whose content is text up to their own end tag, and how a reader sees
// it: as written (raw), with references decoded (rcdata), or not at all.
const HIDDEN_TEXT = 'script style noscript template iframe noembed noframes'.split(' ');
const RAW_TEXT = new Map<string, 'raw' | 'rcdata' | 'hidden'>([
  ...HIDDEN_TEXT.map((name) => [name, 'hidden'] as const),
  ['xmp', 'raw'],
  ['title', 'rcdata'],
  ['textarea', 'rcdata'],
]);

interface Reading {
  readonly html: string;
  readonly lower: string;
  readonly text: string[];
  readonly links: string[];
  readonly styles: string[];
  /** The first `<base href>`: a browser resolves the page's links against it. */
  base?: string;
}

interface Tag {
  readonly end: number;
  readonly attributes: ReadonlyMap<string, string>;
}

function asciiLower(html: string): string {
  return html.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

const isSpace = (char: string): boolean =>
  char === ' ' || char === '\n' || char === '\t' || char === '\f' || char === '\r';
const endsName = (char: string): boolean => isSpace(char) || char === '/' || char === '>';
const endsAttribute = (char: string): boolean => endsName(char) || char === '=';
const endsValue = (char: string): boolean => isSpace(char) || char === '>';
const isAlpha = (char: string): boolean => char >= 'a' && char <= 'z';

/** The first index at or after `from` whose character `stop` accepts, or the end. */
function scan(lower: string, from: number, stop: (char: string) => boolean): number {
  let at = from;
  while (at < lower.length && !stop(lower.charAt(at))) at += 1;
  return at;
}

/**
 * A tag's attributes, from its name's end to past its `>`, by the tokenizer's states: a quoted
 * value may hold `>`, `/` separates attributes, and the first of a name counts.
 */
function readTag(html: string, lower: string, from: number): Tag | undefined {
  const attributes = new Map<string, string>();
  let at = from;
  for (;;) {
    while (isSpace(lower.charAt(at)) || lower.charAt(at) === '/') at += 1;
    if (at >= lower.length) return undefined;
    if (lower.charAt(at) === '>') return { end: at + 1, attributes };
    const start = at;
    at = scan(lower, at + 1, endsAttribute);
    const name = lower.slice(start, at);
    at = scan(lower, at, (char) => !isSpace(char));
    let value = '';
    if (lower.charAt(at) === '=') {
      at = scan(lower, at + 1, (char) => !isSpace(char));
      const quote = lower.charAt(at);
      const close = quote === '"' || quote === "'" ? lower.indexOf(quote, at + 1) : undefined;
      if (close === -1) return undefined;
      const valueEnd = close ?? scan(lower, at, endsValue);
      value = html.slice(close === undefined ? at : at + 1, valueEnd);
      at = close === undefined ? valueEnd : valueEnd + 1;
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
}

/** Where a comment whose text starts at `from` ends (`-->`, `--!>`, `<!-->`, `<!--->`), or -1. */
function commentEnd(lower: string, from: number): number {
  if (lower.startsWith('>', from)) return from + 1;
  if (lower.startsWith('->', from)) return from + 2;
  for (let at = lower.indexOf('--', from); at !== -1; at = lower.indexOf('--', at + 1)) {
    if (lower.charAt(at + 2) === '>') return at + 3;
    if (lower.startsWith('!>', at + 2)) return at + 4;
  }
  return -1;
}

/** Where raw text `name` meets its end tag (`</name` then whitespace, `/` or `>`), or -1. */
function closerAt(lower: string, name: string, from: number): number {
  const opener = `</${name}`;
  for (let at = lower.indexOf(opener, from); at !== -1; at = lower.indexOf(opener, at + 1)) {
    if (endsName(lower.charAt(at + opener.length))) return at;
  }
  return -1;
}

const isStylesheet = (tag: Tag): boolean =>
  asciiLower(decodeReferences(tag.attributes.get('rel') ?? ''))
    .split(/[\t\n\f\r ]+/u)
    .includes('stylesheet');

/** Notes a stylesheet link or the first base address; false where a reference makes it unsure. */
function noteTag(reading: Reading, name: string, tag: Tag): boolean {
  const href = tag.attributes.get('href');
  const wanted =
    name === 'link' ? isStylesheet(tag) : name === 'base' && reading.base === undefined;
  if (href === undefined || !wanted) return true;
  const value = addressValue(href);
  if (value === undefined) return false;
  if (name === 'link') reading.links.push(value);
  else reading.base = value;
  return true;
}

/** Where an element that starts at `open` ends, past its end tag if its content is raw text; or -1. */
function elementEnd(reading: Reading, open: number): number {
  const { html, lower } = reading;
  const nameStop = scan(lower, open + 1, endsName);
  const name = lower.slice(open + 1, nameStop);
  const tag = readTag(html, lower, nameStop);
  if (tag === undefined) return -1;
  if (name === 'plaintext') {
    reading.text.push(html.slice(tag.end));
    return html.length;
  }
  const kind = RAW_TEXT.get(name);
  if (kind === undefined) return noteTag(reading, name, tag) ? tag.end : -1;
  const closer = closerAt(lower, name, tag.end);
  const close = closer === -1 ? undefined : readTag(html, lower, closer + name.length + 2);
  if (close === undefined) return -1;
  const content = html.slice(tag.end, closer);
  if (name === 'style') reading.styles.push(content);
  if (kind !== 'hidden')
    reading.text.push(kind === 'raw' ? content : decodeReferences(content), ' ');
  return close.end;
}

/** Where the markup starting at `open` ends, or -1 where it never does. */
function markupEnd(reading: Reading, open: number): number {
  const { html, lower } = reading;
  if (lower.startsWith('<!--', open)) return commentEnd(lower, open + 4);
  if (isAlpha(lower.charAt(open + 1))) return elementEnd(reading, open);
  if (lower.charAt(open + 1) === '/' && isAlpha(lower.charAt(open + 2))) {
    return readTag(html, lower, scan(lower, open + 2, endsName))?.end ?? -1;
  }
  // A doctype, a bogus comment (`<!x`, `<?x`, `</ x`) or `</>`: up to the first `>`.
  const close = lower.indexOf('>', open + 2);
  return close === -1 ? -1 : close + 1;
}

/** Whether a `<` at `open` starts markup rather than being text. */
function opensMarkup(lower: string, open: number): boolean {
  const next = lower.charAt(open + 1);
  return isAlpha(next) || next === '!' || next === '?' || (next === '/' && open + 2 < lower.length);
}

function readDocument(html: string): (Omit<Reading, 'text'> & { text: string }) | undefined {
  const reading: Reading = { html, lower: asciiLower(html), text: [], links: [], styles: [] };
  let at = 0;
  for (let open = html.indexOf('<'); open !== -1; open = html.indexOf('<', at)) {
    reading.text.push(decodeReferences(html.slice(at, open)));
    if (!opensMarkup(reading.lower, open)) {
      reading.text.push('<');
      at = open + 1;
      continue;
    }
    reading.text.push(' ');
    at = markupEnd(reading, open);
    if (at === -1) return undefined;
  }
  reading.text.push(decodeReferences(html.slice(at)));
  return { ...reading, text: reading.text.join('').replaceAll(/\s+/gu, ' ').trim() };
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
  const base =
    document.base !== undefined && URL.canParse(document.base, page.value.url)
      ? new URL(document.base, page.value.url).href
      : page.value.url;
  const hrefs = document.links.map((href) =>
    URL.canParse(href, base) ? new URL(href, base).href : undefined,
  );
  if (hrefs.includes(undefined)) return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
  const unique = [...new Set(hrefs as string[])];
  if (unique.length > MAX_STYLESHEETS) return { ok: false, code: 'CAPTURE_OVERSIZED' };
  const run = limiter(SHEETS_AT_ONCE);
  const fetched = await Promise.all(
    unique.map((href) =>
      run(() => fencedFetch(href, { ...options, kind: 'stylesheet', page: url })),
    ),
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

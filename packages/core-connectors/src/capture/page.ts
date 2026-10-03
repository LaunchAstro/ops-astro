// SPDX-License-Identifier: AGPL-3.0-only
//
// One fenced capture of a catalogued page, as the observation Receipt L
// compares (fields 9 to 12): the page's visible text, the document's digest,
// and the digest of every stylesheet it serves, linked, inline or imported by
// either (a few levels deep, all within the page's cap). Every fetch goes
// through the fence. A linked stylesheet that cannot be fetched fails the
// whole capture: dropping it would let "the stylesheets are unchanged" pass
// over a stylesheet nobody looked at.

import { createHash } from 'node:crypto';
import {
  Parser,
  Tokenizer,
  defaultTreeAdapter,
  html as markup,
  type DefaultTreeAdapterTypes as Tree,
} from 'parse5';
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

// parse5, the HTML standard's tree builder, reads the page as a browser does. Four of its costs
// grow with the square of a hostile page, so each is bounded: a tag past MAX_ATTRIBUTES (each name
// is checked against all before it), nesting or active formatting entries past MAX_DEPTH (walked
// by many tags) are refused as oversized, and a sibling is looked for from the end, where it sits.
const [MAX_ATTRIBUTES, MAX_DEPTH] = [256, 256];
const PAST_BOUND = new Error('past a bound');

/* oxlint-disable no-underscore-dangle -- the name is parse5's own */
class BoundedTokenizer extends Tokenizer {
  protected override _leaveAttrName(): void {
    const token = this.currentToken;
    if (token && 'attrs' in token && token.attrs.length >= MAX_ATTRIBUTES) throw PAST_BOUND;
    super._leaveAttrName();
  }
}
/* oxlint-enable no-underscore-dangle */

const fromEnd = {
  insertBefore(parent: Tree.ParentNode, node: Tree.ChildNode, before: Tree.ChildNode): void {
    parent.childNodes.splice(parent.childNodes.lastIndexOf(before), 0, node);
    node.parentNode = parent;
  },
  detachNode(node: Tree.ChildNode): void {
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.lastIndexOf(node), 1);
    node.parentNode = null;
  },
  insertTextBefore(parent: Tree.ParentNode, text: string, before: Tree.ChildNode): void {
    const previous = parent.childNodes[parent.childNodes.lastIndexOf(before) - 1];
    if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
    else fromEnd.insertBefore(parent, defaultTreeAdapter.createTextNode(text), before);
  },
};

// Elements whose text a browser does not show: these in HTML, and script and style anywhere.
const HIDDEN = new Set('script style noscript template iframe noembed noframes'.split(' '));

interface Reading {
  readonly text: string;
  readonly links: readonly string[];
  readonly styles: readonly string[];
  readonly base?: string | undefined;
}

const isSpace = (char: string): boolean => /^[\t\n\f\r ]$/u.test(char);

/** The first index at or after `from` whose character `stop` accepts, or the end. */
function scan(text: string, from: number, stop: (char: string) => boolean): number {
  let at = from;
  while (at < text.length && !stop(text.charAt(at))) at += 1;
  return at;
}

/** The page's tree, or undefined where it passes a bound. */
function parsed(html: string): Tree.Document | undefined {
  let depth = 0;
  const onItemPop = () => (depth -= 1);
  const onItemPush = () => {
    depth += 1;
    if (Math.max(depth, parser.activeFormattingElements.entries.length) > MAX_DEPTH)
      throw PAST_BOUND;
  };
  const parser = new Parser<Tree.DefaultTreeAdapterMap>({
    treeAdapter: { ...defaultTreeAdapter, ...fromEnd, onItemPush, onItemPop },
  });
  parser.tokenizer = new BoundedTokenizer(parser.options, parser);
  try {
    parser.tokenizer.write(html, true);
    return parser.document;
  } catch (error) {
    if (error === PAST_BOUND) return undefined;
    throw error;
  }
}

/** Reads the tree in document order with a stack of its own, so no depth can overflow the call stack. */
function readDocument(html: string): Reading | undefined {
  const document = parsed(html);
  if (document === undefined) return undefined;
  const [text, links, styles]: [string[], string[], string[]] = [[], [], []];
  let base: string | undefined;
  const stack: (readonly [Tree.Node, boolean] | undefined)[] = [[document, false]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      text.push(' ');
      continue;
    }
    const [node, hidden] = entry;
    if (node.nodeName === '#text' && !hidden) text.push((node as Tree.TextNode).value);
    if (!('childNodes' in node)) continue;
    let hides = hidden;
    if ('tagName' in node) {
      const html5 = node.namespaceURI === markup.NS.HTML;
      const name = node.tagName;
      const attribute = (wanted: string) => node.attrs.find((one) => one.name === wanted)?.value;
      const href = attribute('href');
      const rel = (attribute('rel') ?? '').replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
      const sheet = name === 'link' && rel.split(/[\t\n\f\r ]+/u).includes('stylesheet');
      if (html5 && sheet && href !== undefined) links.push(href);
      if (html5 && name === 'base' && href !== undefined) base ??= href;
      if (name === 'style' && (html5 || node.namespaceURI === markup.NS.SVG))
        styles.push(node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''));
      hides ||= HIDDEN.has(name) && (html5 || name === 'script' || name === 'style');
      text.push(' ');
      stack.push(undefined);
    }
    for (const child of node.childNodes.toReversed()) stack.push([child, hides]);
  }
  return { text: text.join('').replaceAll(/\s+/gu, ' ').trim(), links, styles, base };
}

// What a stylesheet imports, read in one pass as CSS's tokenizer reads it: comments, strings,
// url() and escapes are skipped whole, so an `@import` inside one is not followed.
const isHex = (char: string): boolean => /^[0-9a-f]$/iu.test(char);
const isNameChar = (char: string): boolean => /^[\w-]$/u.test(char) || char > '\u007F';

/** Where a CSS name starting at `from` ends, escapes included. */
function nameEnd(css: string, from: number): number {
  let at = from;
  for (;;) {
    const char = css.charAt(at);
    if (char === '\\' && at + 1 < css.length && css.charAt(at + 1) !== '\n') {
      at += 2;
      if (isHex(css.charAt(at - 1))) {
        for (let digits = 1; digits < 6 && isHex(css.charAt(at)); digits += 1) at += 1;
        if (isSpace(css.charAt(at))) at += 1;
      }
    } else if (char !== '' && isNameChar(char)) at += 1;
    else return at;
  }
}

/** One CSS escape decoded; a line break after a backslash continues a string. */
function unescaped(_all: string, hex?: string, line?: string, char = ''): string {
  const code = Number.parseInt(hex ?? '', 16);
  if (Number.isNaN(code)) return line === undefined ? char : '';
  const bad = code === 0 || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff;
  return bad ? '\uFFFD' : String.fromCodePoint(code);
}
const cssText = (raw: string): string =>
  raw.replaceAll(/\\(?:([0-9a-f]{1,6})[ \t\n]?|(\n)|([^]))/giu, unescaped);

/** A token's text (undefined where CSS drops it) and where it ends. */
type CssToken = { readonly text?: string | undefined; readonly end: number };

/** A string token at `from`, its text (undefined if a line break ends it) and its end. */
function cssString(css: string, from: number): CssToken {
  const quote = css.charAt(from);
  let at = from + 1;
  while (at < css.length && css.charAt(at) !== quote && css.charAt(at) !== '\n')
    at += css.charAt(at) === '\\' ? 2 : 1;
  if (css.charAt(at) === '\n') return { end: at };
  return { text: cssText(css.slice(from + 1, Math.min(at, css.length))), end: at + 1 };
}

/** After `url(` at `from`: an unquoted address and its end, or undefined where a string follows. */
function cssUrl(css: string, from: number): CssToken | undefined {
  const start = scan(css, from, (char) => !isSpace(char));
  if (css.charAt(start) === '"' || css.charAt(start) === "'") return undefined;
  let at = start;
  while (at < css.length && css.charAt(at) !== ')') at += css.charAt(at) === '\\' ? 2 : 1;
  const raw = css.slice(start, at).trimEnd();
  return { text: /["'(\s]/u.test(raw) ? undefined : cssText(raw), end: at + 1 };
}

/** Where a comment opening at `from` ends: past its close, or at the end of the sheet. */
function commentEnd(css: string, from: number): number {
  const close = css.indexOf('*/', from + 2);
  return close === -1 ? css.length : close + 2;
}

/** The address an `@import` whose name ends at `from` names, if any, and where it ends. */
function importAt(css: string, from: number): CssToken {
  let at = scan(css, from, (char) => !isSpace(char));
  while (css.startsWith('/*', at)) at = scan(css, commentEnd(css, at), (char) => !isSpace(char));
  const char = css.charAt(at);
  if (char === '"' || char === "'") return cssString(css, at);
  const end = nameEnd(css, at);
  if (cssText(css.slice(at, end)).toLowerCase() !== 'url' || css.charAt(end) !== '(')
    return { end: Math.max(end, at + 1) };
  const open = scan(css, end + 1, (next) => !isSpace(next));
  return cssUrl(css, end + 1) ?? cssString(css, open);
}

/** Every address the sheet's `@import` rules name, as written. */
function importsOf(source: string): string[] {
  const css = source.replaceAll(/\r\n?|\f/gu, '\n');
  const found: string[] = [];
  let at = 0;
  while (at < css.length) {
    const char = css.charAt(at);
    const end = char === '@' ? nameEnd(css, at + 1) : nameEnd(css, at);
    const name = cssText(css.slice(char === '@' ? at + 1 : at, end)).toLowerCase();
    if (css.startsWith('/*', at)) at = commentEnd(css, at);
    else if (char === '"' || char === "'") at = cssString(css, at).end;
    else if (char === '@' && name === 'import') {
      const named = importAt(css, end);
      if (named.text !== undefined) found.push(named.text);
      at = named.end;
    } else if (char !== '@' && name === 'url' && css.charAt(end) === '(')
      at = cssUrl(css, end + 1)?.end ?? end + 1;
    else at = Math.max(end, at + 1);
  }
  return found;
}

/** Rounds of `@import` followed past the sheets the page names; one more is refused as oversized. */
const IMPORT_DEPTH = 3;

const resolved = (href: string, from: string): string | undefined =>
  URL.canParse(href, from) ? new URL(href, from).href : undefined;

/** The digest of every sheet the page serves: inline, linked, and imported by either. */
async function readSheets(
  url: string,
  base: string,
  document: { readonly links: readonly string[]; readonly styles: readonly string[] },
  options: CaptureOptions,
): Promise<Fenced<Record<string, string>>> {
  const stylesheets: Record<string, string> = {};
  for (const [index, css] of document.styles.entries())
    stylesheets[`inline:${index}`] = digest(css);
  const seen = new Set<string>();
  const run = limiter(SHEETS_AT_ONCE);
  let wanted = [...document.links, ...document.styles.flatMap(importsOf)].map((href) =>
    resolved(href, base),
  );
  for (let depth = 0; wanted.length > 0; depth += 1) {
    if (wanted.includes(undefined)) return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
    const fresh = [...new Set(wanted as string[])].filter((href) => !seen.has(href));
    if (fresh.length > 0 && (depth > IMPORT_DEPTH || seen.size + fresh.length > MAX_STYLESHEETS))
      return { ok: false, code: 'CAPTURE_OVERSIZED' };
    for (const href of fresh) seen.add(href);
    // oxlint-disable-next-line no-await-in-loop -- one round of imports waits on the last
    const fetched = await Promise.all(
      fresh.map((href) =>
        run(() => fencedFetch(href, { ...options, kind: 'stylesheet', page: url })),
      ),
    );
    wanted = [];
    for (const [index, sheet] of fetched.entries()) {
      if (!sheet.ok) return sheet;
      stylesheets[fresh[index] ?? ''] = digest(sheet.value.body);
      wanted.push(...importsOf(sheet.value.body).map((href) => resolved(href, sheet.value.url)));
    }
  }
  return { ok: true, value: stylesheets };
}

export async function capturePage(
  url: string,
  options: CaptureOptions,
): Promise<Fenced<PageObservation>> {
  const page = await fencedFetch(url, { ...options, kind: 'document' });
  if (!page.ok) return page;
  const html = page.value.body;
  const document = readDocument(html);
  if (document === undefined) return { ok: false, code: 'CAPTURE_OVERSIZED' };
  const base = resolved(document.base ?? '', page.value.url) ?? page.value.url;
  const sheets = await readSheets(url, base, document, options);
  if (!sheets.ok) return sheets;
  const sorted = Object.fromEntries(
    Object.entries(sheets.value).toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
  const value = { url: page.value.url, status: page.value.status, documentDigest: digest(html) };
  return { ok: true, value: { ...value, text: document.text, stylesheets: sorted } };
}

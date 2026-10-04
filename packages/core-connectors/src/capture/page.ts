// SPDX-License-Identifier: AGPL-3.0-only
//
// One fenced capture of a catalogued page, as the observation Receipt L compares (fields 9 to 12):
// the page's visible text, the document's digest, and the digest of every stylesheet it serves,
// linked, inline or imported by either (a few levels deep, all within the page's cap). Every fetch
// goes through the fence. A linked stylesheet that cannot be fetched fails the whole capture:
// dropping it would let "the stylesheets are unchanged" pass over a stylesheet nobody looked at.

import { createHash } from 'node:crypto';
import {
  Parser,
  Tokenizer,
  defaultTreeAdapter,
  html as markup,
  type DefaultTreeAdapterTypes as Tree,
  type TreeAdapter,
} from 'parse5';
import type { PageObservation } from '../site/envelope.ts';
import {
  MAX_STYLESHEETS,
  SHEETS_AT_ONCE,
  fencedFetch,
  isUtf8Label,
  limiter,
  type FenceCode,
  type FetchOptions,
  type Fenced,
} from './fence.ts';

export type CaptureOptions = Omit<FetchOptions, 'kind' | 'page'>;
const digest = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// parse5, the HTML standard's tree builder, reads the page as a browser does. Costs that outgrow a
// hostile page are refused as oversized past: MAX_ATTRIBUTES on a tag, or on an <html> or <body>
// later tags merge theirs onto; MAX_DEPTH open elements or formatting entries; WORK times the
// page's length of siblings moves scan and shift (found from the end); and the page's length and
// IMPLIED of nodes and attributes made (text rebuilds each formatting element closed but listed).
const [MAX_ATTRIBUTES, MAX_DEPTH, WORK, IMPLIED] = [256, 256, 64, 64];
const PAST_BOUND = new Error('past a bound');
class BoundedTokenizer extends Tokenizer {
  protected override _leaveAttrName(): void {
    const token = this.currentToken;
    if (token && 'attrs' in token && token.attrs.length >= MAX_ATTRIBUTES) throw PAST_BOUND;
    // oxlint-disable-next-line no-underscore-dangle -- the name is parse5's own
    super._leaveAttrName();
  }
}

function moves(length: number) {
  let [left, nodes] = [WORK * length, length + IMPLIED];
  const made = <Made>(node: Made, attributes = 0): Made => {
    if ((nodes -= 1 + attributes) < 0) throw PAST_BOUND;
    return node;
  };
  const at = (parent: Tree.ParentNode, node: Tree.ChildNode): number => {
    const index = parent.childNodes.lastIndexOf(node);
    left -= parent.childNodes.length - index;
    if (left < 0) throw PAST_BOUND;
    return index;
  };
  const adapter = {
    createElement: (tag, space, attrs) =>
      made(defaultTreeAdapter.createElement(tag, space, attrs), attrs.length),
    createCommentNode: (data) => made(defaultTreeAdapter.createCommentNode(data)),
    createDocumentFragment: () => made(defaultTreeAdapter.createDocumentFragment()),
    insertText: (parent, text) => defaultTreeAdapter.insertText(made(parent), text),
    insertBefore(parent: Tree.ParentNode, node: Tree.ChildNode, before: Tree.ChildNode): void {
      parent.childNodes.splice(at(parent, before), 0, node);
      node.parentNode = parent;
    },
    detachNode(node: Tree.ChildNode): void {
      if (node.parentNode) node.parentNode.childNodes.splice(at(node.parentNode, node), 1);
      node.parentNode = null;
    },
    insertTextBefore(parent: Tree.ParentNode, text: string, before: Tree.ChildNode): void {
      const previous = parent.childNodes[at(made(parent), before) - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
      else adapter.insertBefore(parent, defaultTreeAdapter.createTextNode(text), before);
    },
    adoptAttributes(recipient: Tree.Element, attrs: Tree.Element['attrs']): void {
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
      if (recipient.attrs.length > MAX_ATTRIBUTES) throw PAST_BOUND;
    },
  } satisfies Partial<TreeAdapter<Tree.DefaultTreeAdapterMap>>;
  return adapter;
}

// Elements whose text a browser does not show: these in HTML, and script and style anywhere.
const HIDDEN = new Set('script style noscript template iframe noembed noframes'.split(' '));
// Attributes that make a browser render what the capture cannot read: a declarative shadow root
// (its own text and sheets, the element's children hidden) and a frame's inline document. A sheet
// with no charset of its own is decoded in its link's charset, so that must name UTF-8 or nothing.
const UNREAD = new Map<string, string[]>()
  .set('template', ['shadowrootmode', 'shadowroot'])
  .set('iframe', ['srcdoc']);
/** What the page shows and loads: its text, linked and inline sheets, and its base ('' if none). */
type Reading = Readonly<{ text: string; links: string[]; styles: string[]; base: string }>;
/** The page's tree, or undefined where it passes a bound. */
function parsed(html: string): Tree.Document | undefined {
  // Read from parse5's own counts after each push; a count it no longer keeps reads as past.
  const onItemPush = () => {
    const depth = parser.openElements.stackTop + 1;
    if (!(Math.max(depth, parser.activeFormattingElements.entries.length) <= MAX_DEPTH))
      throw PAST_BOUND;
  };
  const parser = new Parser<Tree.DefaultTreeAdapterMap>({
    treeAdapter: { ...defaultTreeAdapter, ...moves(html.length), onItemPush },
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
// The bounds lean on parse5's internals. If a release drops a member they override, or stops
// honouring one, the capture refuses to load rather than read pages unbounded.
const names = Array.from({ length: MAX_ATTRIBUTES }, (_, at) => ` a${at}`).join('');
const held = [
  Reflect.get(Tokenizer.prototype, '_leaveAttrName'),
  ...Object.keys(moves(0)).map((name) => Reflect.get(defaultTreeAdapter, name)),
].every((member) => typeof member === 'function');
const moved = `<b><p>${'<br>'.repeat(16 * WORK)}</b>`;
const rebuilt = `<div${names.split(' ', 65).join('><b ')}></div>${'<div>X</div>'.repeat(64)}`;
const probes = [`<p${names} z>`, `<html${names}><html z>`, '<b>'.repeat(MAX_DEPTH), moved, rebuilt];
if (!held || probes.some((probe) => parsed(probe) !== undefined))
  throw new Error('parse5 no longer holds the capture bounds');

/** Reads the tree in document order with a stack of its own, so no depth can overflow the call stack. */
function readDocument(html: string): Reading | FenceCode {
  const document = parsed(html);
  if (document === undefined) return 'CAPTURE_OVERSIZED';
  const [text, links, styles]: [string[], string[], string[]] = [[], [], []];
  let base: string | undefined;
  const stack: (readonly [Tree.Node, boolean])[] = [[document, false]];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [node, hidden] = entry;
    if (node.nodeName === '#text' && !hidden) text.push((node as Tree.TextNode).value);
    if (!('childNodes' in node)) continue;
    let hides = hidden;
    if ('tagName' in node) {
      const html5 = node.namespaceURI === markup.NS.HTML;
      const name = node.tagName;
      if (html5 && node.attrs.some((one) => UNREAD.get(name)?.includes(one.name)))
        return 'CAPTURE_BODY_MALFORMED';
      const attribute = (wanted: string) => node.attrs.find((one) => one.name === wanted)?.value;
      const href = attribute('href');
      const rel = (attribute('rel') ?? '').replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
      const sheet = html5 && name === 'link' && rel.split(/[\t\n\f\r ]+/u).includes('stylesheet');
      if (sheet && !isUtf8Label(attribute('charset') ?? 'utf-8')) return 'CAPTURE_BODY_MALFORMED';
      if (sheet && href !== undefined) links.push(href);
      if (html5 && name === 'base' && href !== undefined) base ??= href;
      if (name === 'style' && (html5 || node.namespaceURI === markup.NS.SVG))
        styles.push(node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''));
      hides ||= HIDDEN.has(name) && (html5 || name === 'script' || name === 'style');
      text.push(' ');
      stack.push([defaultTreeAdapter.createTextNode(' '), false]);
    }
    for (const child of node.childNodes.toReversed()) stack.push([child, hides]);
  }
  return { text: text.join('').replaceAll(/\s+/gu, ' ').trim(), links, styles, base: base ?? '' };
}

// What a stylesheet imports, read a token at a time as CSS Syntax 3 reads it after its
// preprocessing, so an `@import` in a comment, string or url() is not followed. Only space, tab and
// line feed are whitespace. Every loop below steps over a run or an escape, so a read is linear.
const ESCAPE = String.raw`\\(?:[0-9a-f]{1,6}[ \t\n]?|[^\n]|$)`;
const STRING = (quote: string): string =>
  String.raw`${quote}([^${quote}\\\n]*(?:(?:${ESCAPE}|\\\n)[^${quote}\\\n]*)*)(${quote})?`;
const TOKEN = new RegExp(
  String.raw`[ \t\n]+|/\*[^*]*(?:\*+(?!/)[^*]*)*(?:\*/|$)|${STRING('"')}|${STRING("'")}|([#@]?)((?:[\w\-\P{ASCII}]+|${ESCAPE})+)|[^]`,
  'iuy',
);
// After `url(`: a quote ahead (a string follows), or an address and its `)`; with no `)` the url is
// bad (a space inside, a quote, `(` or a non-printable code point), read on to its `)`.
const URL_TAIL = new RegExp(
  String.raw`[ \t\n]*(?:(?=["'])|((?:[^"'()\\ \t\n\0-\b\v\x0E-\x1F\x7F]+|${ESCAPE})*)[ \t\n]*` +
    String.raw`(?:(\)|$)|[^)\\]*(?:(?:${ESCAPE}|\\)[^)\\]*)*\)?))`,
  'iuy',
);

/** One CSS escape decoded; a line break after a backslash continues a string. */
function unescaped(_all: string, hex?: string, line?: string, char = ''): string {
  const code = Number.parseInt(hex ?? '', 16);
  if (Number.isNaN(code)) return line === undefined ? char : '';
  const bad = code === 0 || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff;
  return bad ? '\uFFFD' : String.fromCodePoint(code);
}
/** Escapes decoded; a backslash at the end of the sheet becomes `atEnd` (a string drops it). */
const cssText = (raw: string, atEnd = ''): string =>
  raw.replaceAll(/\\(?:([0-9a-f]{1,6})[ \t\n]?|(\n)|([^])|$)/giu, (all, hex, line, char) =>
    unescaped(all, hex, line, char ?? atEnd),
  );
/** A token's kind, its text (a string's or url's, undefined where CSS reads it bad) and its end. */
type CssToken = { readonly kind: string; readonly text?: string | undefined; readonly end: number };
/** The token at `at`: space, a comment, a string, a url, `url(` before a string, `@name`, other. */
function cssToken(css: string, at: number): CssToken {
  TOKEN.lastIndex = at;
  const [all = '', double, closed, single, closedSingle, sign, name] = TOKEN.exec(css) ?? [];
  const end = at + all.length;
  if (double !== undefined || single !== undefined) {
    const bad = (closed ?? closedSingle) === undefined && end < css.length;
    return { kind: 'string', text: bad ? undefined : cssText(double ?? single ?? ''), end };
  }
  if (name === undefined) return { kind: /^(?:[ \t\n]|\/\*)/u.test(all) ? ' ' : 'other', end };
  const word = cssText(name, '\uFFFD').toLowerCase();
  if (sign === '@') return { kind: `@${word}`, end };
  if (sign === '#' || word !== 'url' || css.charAt(end) !== '(') return { kind: 'name', end };
  URL_TAIL.lastIndex = end + 1;
  const [tail = '', address, close] = URL_TAIL.exec(css) ?? [];
  if (address === undefined) return { kind: 'url(', end: end + 1 };
  const text = close === undefined ? undefined : cssText(address, '\uFFFD');
  return { kind: 'url', text, end: end + 1 + tail.length };
}

/** Every address the sheet's `@import` rules name; undefined for one CSS cannot read. */
function importsOf(source: string): (string | undefined)[] {
  const css = source.replaceAll(/\r\n?|\f/gu, '\n').replaceAll('\0', '\uFFFD');
  const next = (from: number): CssToken => {
    let token = cssToken(css, from);
    while (token.kind === ' ') token = cssToken(css, token.end);
    return token;
  };
  const found: (string | undefined)[] = [];
  for (let at = 0; at < css.length;) {
    let token = cssToken(css, at);
    if (token.kind === '@import') {
      token = next(token.end);
      if (token.kind === 'url(') token = next(token.end);
      found.push(token.kind === 'string' || token.kind === 'url' ? token.text : undefined);
    }
    at = token.end;
  }
  return found;
}

/** Rounds of `@import` followed past the sheets the page names; one more is refused as oversized. */
const IMPORT_DEPTH = 3;
const resolved = (href: string | undefined, from: string): string | undefined =>
  href !== undefined && URL.canParse(href, from) ? new URL(href, from).href : undefined;
/** The encoding a sheet declares as CSS reads it: a `@charset` rule at its very start. */
const declared = (css: string): string => /^@charset "([^"]*)";/u.exec(css)?.[1] ?? 'utf-8';
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
  const fetchSheet = (href: string) =>
    run(() => fencedFetch(href, { ...options, kind: 'stylesheet', page: url }));
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
    const fetched = await Promise.all(fresh.map((href) => fetchSheet(href)));
    wanted = [];
    for (const [index, sheet] of fetched.entries()) {
      if (!sheet.ok) return sheet;
      if (!isUtf8Label(declared(sheet.value.body)))
        return { ok: false, code: 'CAPTURE_BODY_MALFORMED' };
      stylesheets[fresh[index] ?? ''] = digest(sheet.value.body);
      for (const href of importsOf(sheet.value.body)) wanted.push(resolved(href, sheet.value.url));
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
  if (typeof document === 'string') return { ok: false, code: document };
  const base = resolved(document.base, page.value.url) ?? page.value.url;
  const sheets = await readSheets(url, base, document, options);
  if (!sheets.ok) return sheets;
  const sorted = Object.fromEntries(
    Object.entries(sheets.value).toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
  const value = { url: page.value.url, status: page.value.status, documentDigest: digest(html) };
  return { ok: true, value: { ...value, text: document.text, stylesheets: sorted } };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// CSS read a token at a time, as the capture needs it: the sheets a stylesheet imports, and whether
// an element's inline style may hide it.

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
/** A token's kind, its text (a name's decoded word, or a string's or url's, undefined where CSS reads it bad) and its end. */
type CssToken = { readonly kind: string; readonly text?: string | undefined; readonly end: number };
/** The token at `at`: space, a comment, a string, a url, `url(` before a string, `@name`, a hash, a name, other. */
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
  if (sign === '#') return { kind: 'hash', end };
  if (word !== 'url' || css.charAt(end) !== '(') return { kind: 'name', text: word, end };
  URL_TAIL.lastIndex = end + 1;
  const [tail = '', address, close] = URL_TAIL.exec(css) ?? [];
  if (address === undefined) return { kind: 'url(', end: end + 1 };
  const text = close === undefined ? undefined : cssText(address, '\uFFFD');
  return { kind: 'url', text, end: end + 1 + tail.length };
}

/** A sheet or style attribute as CSS reads it after its preprocessing. */
const preprocessed = (source: string): string =>
  source.replaceAll(/\r\n?|\f/gu, '\n').replaceAll('\0', '\uFFFD');

// What an inline style's `display` may read without hiding its element. A column box draws none of
// its contents, and `contents` reads as `none` on some elements (a textarea, an object, most SVG), so
// those are left out. A value this reader cannot decide (a variable, `revert-layer` to a sheet, a
// function, an unknown word) counts as `none`, so a correction inside it never certifies live. Only
// the inline style is read: a page's sheets can hide an element too (by class, id or media query),
// and their cascade is not computed here.
const SHOWN = new Set(
  (
    'block inline run-in flow flow-root table flex grid ruby math list-item ' +
    'inline-block inline-table inline-flex inline-grid table-row-group table-header-group ' +
    'table-footer-group table-row table-cell table-caption ' +
    'ruby-base ruby-text ruby-base-container ruby-text-container inherit initial unset'
  ).split(' '),
);
const OPENS = new Map([
  ['(', ')'],
  ['url(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
/**
 * Whether a style attribute may hide its element: a `display` declaration with any word outside
 * SHOWN. Declarations end at a `;` outside every block. An at-rule or a block outside every block
 * may end a declaration without one, as browsers read it, so either counts as hiding.
 */
export function hiddenStyle(source: string): boolean {
  const css = preprocessed(source);
  const declarations: string[][] = [[]];
  const closers: string[] = [];
  for (let at = 0; at < css.length;) {
    const token = cssToken(css, at);
    const raw = css.slice(at, token.end);
    at = token.end;
    if (token.kind === ' ') continue;
    if (closers.length === 0 && (token.kind.startsWith('@') || raw === '{')) return true;
    const opened = OPENS.get(token.kind === 'url(' ? 'url(' : raw);
    if (opened !== undefined) closers.push(opened);
    else if (raw === closers.at(-1)) closers.pop();
    else if (raw === ';' && closers.length === 0) {
      declarations.push([]);
      continue;
    }
    // A name stands for its decoded word; anything else for its kind and characters, never a word.
    declarations.at(-1)?.push(token.kind === 'name' ? (token.text ?? '') : `${token.kind}:${raw}`);
  }
  return declarations.some(([name, colon, ...value]) => {
    if (name !== 'display' || colon !== 'other::') return false;
    const important = value.at(-2) === 'other:!' && value.at(-1) === 'important';
    return (important ? value.slice(0, -2) : value).some((word) => !SHOWN.has(word));
  });
}

/** Every address the sheet's `@import` rules name; undefined for one CSS cannot read. */
export function importsOf(source: string): (string | undefined)[] {
  const css = preprocessed(source);
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

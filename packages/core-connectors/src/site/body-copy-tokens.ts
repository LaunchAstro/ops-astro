// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether an edited word is body copy, read from the page Astro's compiler
// prints rather than from the source. The check is a closed grammar: it
// accepts one shape and refuses everything else, unknown input included.
//
// - The two compiled modules differ by the one word, at one place, in the
//   static text of a `$$render` template (`compiled-module.ts`).
// - The template, tokenised as a browser tokenises HTML up to the word,
//   meets every expression in a state the grammar knows. An attribute call
//   must land in a tag, and anything else in data state.
// - The first token after the last expression is a tag, and the text from
//   there to the word holds no '<'.
// - The word sits in a character token with no character reference before
//   it, and every element open around it is allow-listed. The innermost is
//   a tag the built page prints where the source has it.
//
// - Every `$$render` template in the module, the ones its fragments,
//   component children and expressions nest included, meets its own
//   expressions the same way and ends in data state with every tag it
//   opened closed, and opens no select.
//
// What another file prints is taken as whole markup. A page that prints
// raw HTML itself (set:html) is refused.

import type { TemplateLiteral } from 'acorn';
import { Token, Tokenizer, TokenizerMode, type TokenHandler } from 'parse5';
import { interpolation, wordInTemplate, type WordSwap } from './compiled-module.ts';

/** Tags a browser opens and closes where the compiler prints them, around body copy. */
const PRINTED_IN_PLACE: ReadonlySet<string> = new Set(
  (
    'a abbr address article aside b bdi bdo blockquote cite code data dd del dfn div ' +
    'dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header i ins kbd label li ' +
    'main mark nav ol p pre q s samp section small span strong sub sup time u ul var'
  ).split(' '),
);
const OPEN_AROUND_COPY: ReadonlySet<string> = new Set([...PRINTED_IN_PLACE, 'html', 'body']);
const VOID: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta source track wbr'.split(' '),
);
type Mode = (typeof TokenizerMode)[keyof typeof TokenizerMode];
/** Where a browser's tree builder moves its tokenizer out of data state. */
const TEXT_MODES: ReadonlyMap<string, Mode> = new Map([
  ['title', TokenizerMode.RCDATA],
  ['textarea', TokenizerMode.RCDATA],
  ['style', TokenizerMode.RAWTEXT],
  ['xmp', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT],
  ['noembed', TokenizerMode.RAWTEXT],
  ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT],
  ['script', TokenizerMode.SCRIPT_DATA],
  ['plaintext', TokenizerMode.PLAINTEXT],
]);
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const STAND_IN = 'data-envelope-stand-in-';

type Kept = Token.TagToken | Token.CharacterToken | Token.CommentToken;

interface Seen {
  readonly token: Kept;
  readonly start: number;
  readonly end: number;
}

/** A tokenizer that moves to raw text where a browser's tree builder would; `onTag` sees start tags. */
function tokenizerFor(keep: (token: Kept) => void, onTag: (token: Token.TagToken) => void) {
  const handler: TokenHandler = {
    onComment: keep,
    onDoctype: () => {},
    onStartTag: (token) => {
      keep(token);
      onTag(token);
      const mode = TEXT_MODES.get(token.tagName);
      if (mode !== undefined) tokenizer.state = mode;
    },
    onEndTag: keep,
    onEof: () => {},
    onCharacter: keep,
    onNullCharacter: keep,
    onWhitespaceCharacter: keep,
  };
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, handler);
  return tokenizer;
}

/**
 * The template's tokens up to the end of static text `last`, the text
 * tokenised, and where the last expression before it ended; `undefined`
 * when an expression meets a state the grammar does not know.
 */
function tokensUpTo(template: TemplateLiteral, last: number) {
  const seen: Seen[] = [];
  const attributes = new Set<string>();
  const tokenizer = tokenizerFor(
    (token) => {
      const { startOffset, endOffset } = token.location ?? { startOffset: -1, endOffset: -1 };
      seen.push({ token, start: startOffset, end: endOffset });
    },
    (token) => {
      for (const { name } of token.attrs) attributes.add(name);
    },
  );
  let stream = '';
  let resumes = 0;
  for (const [index, quasi] of template.quasis.slice(0, last + 1).entries()) {
    if (typeof quasi.value.cooked !== 'string') return;
    stream += quasi.value.cooked;
    tokenizer.write(quasi.value.cooked, false);
    const expression = index < last ? template.expressions[index] : undefined;
    if (expression === undefined) continue;
    const kind = interpolation(expression);
    const { state } = tokenizer;
    if (kind === 'attributes') {
      // Stands in for ` name="value"`; it must come out as an attribute of a tag.
      const standIn = ` ${STAND_IN}${index}=""`;
      stream += standIn;
      tokenizer.write(standIn, false);
    } else if (
      (kind === 'markup' && state === TokenizerMode.DATA) ||
      (kind === 'text' && (state === TokenizerMode.DATA || state === TokenizerMode.RCDATA))
    ) {
      resumes = stream.length;
    } else {
      return;
    }
  }
  const ending = tokenizer.state;
  tokenizer.write('', true);
  const placed = template.expressions
    .slice(0, last)
    .every((expression, index) =>
      interpolation(expression) === 'attributes' ? attributes.has(`${STAND_IN}${index}`) : true,
    );
  return placed ? { seen, stream, resumes, ending } : undefined;
}

/** The elements open at `before`, or `undefined` when an end tag closes another. */
function openAt(seen: readonly Seen[], before: number): string[] | undefined {
  const open: string[] = [];
  for (const { token, start } of seen) {
    if (start >= before) break;
    if (token.type === Token.TokenType.START_TAG) {
      if (!VOID.has(token.tagName)) open.push(token.tagName);
    } else if (token.type === Token.TokenType.END_TAG) {
      if (open.at(-1) !== token.tagName) return;
      open.pop();
    }
  }
  return open;
}

/** Whether the elements open at `before` are all allow-listed, the innermost printed in place. */
function openAroundCopy(seen: readonly Seen[], before: number): boolean {
  const open = openAt(seen, before) ?? [];
  const innermost = open.at(-1);
  return (
    innermost !== undefined &&
    PRINTED_IN_PLACE.has(innermost) &&
    open.every((name) => OPEN_AROUND_COPY.has(name))
  );
}

/**
 * Whether the whole template meets its expressions in known states and
 * ends as it began: in data state, every tag it opened closed, no select.
 */
function closes(template: TemplateLiteral): boolean {
  const read = tokensUpTo(template, template.quasis.length - 1);
  if (read?.ending !== TokenizerMode.DATA) return false;
  const select = read.seen.some(
    ({ token }) => token.type === Token.TokenType.START_TAG && token.tagName === 'select',
  );
  return !select && openAt(read.seen, Number.POSITIVE_INFINITY)?.length === 0;
}

/** Whether the word from `from` to `to` is a whole word, alone in a reference-free character token. */
function wordInCharacters(seen: readonly Seen[], stream: string, from: number, to: number) {
  const holder = seen.find(({ start, end }) => start <= from && to <= end);
  if (holder?.token.type !== Token.TokenType.CHARACTER || !('chars' in holder.token)) return false;
  const { token, start, end } = holder;
  if (stream.slice(start, end) !== token.chars) return false;
  if (token.chars.slice(from - start, to - start) !== stream.slice(from, to)) return false;
  if (stream.slice(start, from).includes('&')) return false;
  // Whole characters, never one code unit: half a surrogate pair is no letter.
  const left = Array.from(stream.slice(Math.max(0, from - 2), from)).at(-1) ?? '';
  const right = Array.from(stream.slice(to, to + 2))[0] ?? '';
  return !WORD_CHARACTER.test(left) && !WORD_CHARACTER.test(right);
}

/** Whether a tag comes first after the last expression, and the text from it to the word holds no '<'. */
function resyncedBefore(seen: readonly Seen[], resumes: number, from: number): boolean {
  const next = seen.find(
    ({ token, start }) => start >= resumes && token.type !== Token.TokenType.WHITESPACE_CHARACTER,
  );
  if (next === undefined || next.start >= from) return false;
  const { type } = next.token;
  if (type !== Token.TokenType.START_TAG && type !== Token.TokenType.END_TAG) return false;
  // parse5 places a '<' it reads as text a character off, so its characters are read, not the stream.
  return !seen.some(
    ({ token, start }) =>
      token.type === Token.TokenType.CHARACTER &&
      start >= next.start &&
      start < from &&
      'chars' in token &&
      token.chars.includes('<'),
  );
}

/**
 * Whether `swap` changes one word of body copy and nothing else, given the
 * compiled modules of the page before and after, their types blanked.
 */
export function swapsOnlyBodyCopy(before: string, after: string, swap: WordSwap): boolean {
  const found = wordInTemplate(before, after, swap);
  if (found === undefined || !found.templates.every((template) => closes(template))) {
    return false;
  }
  const { template, quasi, offset } = found.word;
  const read = tokensUpTo(template, quasi);
  if (read === undefined) return false;
  const { seen, stream, resumes } = read;
  const from = stream.length - (template.quasis[quasi]?.value.cooked?.length ?? 0) + offset;
  const to = from + swap.word.length;
  return (
    wordInCharacters(seen, stream, from, to) &&
    resyncedBefore(seen, resumes, from) &&
    openAroundCopy(seen, from)
  );
}

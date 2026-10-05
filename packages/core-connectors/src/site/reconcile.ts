// SPDX-License-Identifier: AGPL-3.0-only
//
// How the executable knows what its effect did, beyond the provider's answer:
// a send that may repeat an earlier one is read back through its seam first
// (broker contract 3.4), and a page is observed at the approved occurrence of
// the word, never by the word anywhere on it.

import type { ProviderResult } from '../call.ts';
import { html as markup, parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { readDocument } from '../capture/page.ts';
import { wordOffsets, type CorrectionTarget, type ProposedChange } from './envelope.ts';
import { siteOperation } from './operations.ts';

/** An effect read back through its seam: landed, provably absent, or not known. */
export type ReadBack<T> =
  | { readonly state: 'landed'; readonly value: T }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown' };

/** Refusals an effect that already landed also earns: read back before they count as failed. */
const ALSO_IF_LANDED: ReadonlySet<string> = new Set(['not_mergeable', 'sha_mismatch']);

/**
 * A send that may repeat an earlier one: landed is the answer, only proof that nothing landed
 * lets `send` go, anything else stays unknown. A refusal a late landing also explains is read
 * back again: landed is the answer, absent keeps the refusal, anything else is unknown.
 */
export async function reconciled<T>(
  back: ReadBack<T>,
  send: () => Promise<ProviderResult<T>>,
  readBack: () => Promise<ReadBack<T>>,
): Promise<ProviderResult<T>> {
  const unproven = { kind: 'unknown', code: 'RECONCILE_UNPROVEN' } as const;
  if (back.state === 'landed') return { kind: 'ok', value: back.value };
  if (back.state !== 'absent') return unproven;
  const answer = await send();
  if (answer.kind !== 'refused' || !ALSO_IF_LANDED.has(answer.proof ?? '')) return answer;
  const after = await readBack();
  if (after.state === 'landed') return { kind: 'ok', value: after.value };
  return after.state === 'absent' ? answer : unproven;
}

const claims = new Map<string, Promise<unknown>>();

/** One caller per seam and token in this process holds the read back through the send (across runners, the lease). */
export async function claimed<T>(seam: string, token: string, work: () => Promise<T>): Promise<T> {
  const key = `${seam} ${token}`;
  const mine = (claims.get(key) ?? Promise.resolve()).then(work, work);
  claims.set(key, mine);
  try {
    return await mine;
  } finally {
    if (claims.get(key) === mine) claims.delete(key);
  }
}

type Proven = { readonly kind: 'refused'; readonly code: string; readonly proof: string };

/** A refusal carrying one of the operation's declared nothing-happened proofs. */
export function proven(operation: string, answer: ProviderResult<unknown>): answer is Proven {
  const proofs = siteOperation(operation).declaration.nothing_happened_proof;
  return answer.kind === 'refused' && answer.proof !== undefined && proofs.includes(answer.proof);
}

/** Where the approved word sits: its rendered block either side (CONTEXT at most), and its rank among equal matches. */
export interface Occurrence {
  readonly left: string;
  readonly right: string;
  readonly index?: number;
}

// Elements that start a rendered block of their own.
const BLOCK = new Set(
  (
    'address article aside blockquote br dd div dt figcaption footer h1 h2 h3 h4 h5 h6 header ' +
    'hr li main nav p section td th'
  ).split(' '),
);
// Elements whose text the capture never reads (capture/page.ts): these in HTML, and script and
// style anywhere.
const HIDDEN = new Set('script style noscript template iframe noembed noframes'.split(' '));
const MARK = '\uE000';
const visible = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

type Step = { readonly node: Tree.Node; readonly hidden: boolean } | { readonly block: boolean };

/**
 * Markup as the capture reads it, block by block: parse5's tree, so no hidden element's text
 * counts and every character reference decodes as a browser decodes it. Undefined where the
 * capture refuses the markup, or reads the whole page otherwise than these blocks joined.
 */
function rendered(html: string): string[] | undefined {
  const whole = readDocument(html);
  if (typeof whole === 'string') return undefined;
  const blocks = [''];
  const stack: Step[] = [{ node: parse(html), hidden: false }];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    if ('block' in step) {
      if (step.block) blocks.push('');
      else blocks[blocks.length - 1] += ' ';
      continue;
    }
    const { node, hidden } = step;
    if (node.nodeName === '#text' && !hidden)
      blocks[blocks.length - 1] += (node as Tree.TextNode).value;
    if (!('childNodes' in node)) continue;
    let hides = hidden;
    if ('tagName' in node) {
      const html5 = node.namespaceURI === markup.NS.HTML;
      const name = node.tagName;
      hides ||= HIDDEN.has(name) && (html5 || name === 'script' || name === 'style');
      // An element breaks the text where it opens and closes, a block element into a new block.
      const block = html5 && BLOCK.has(name);
      if (block) blocks.push('');
      else blocks[blocks.length - 1] += ' ';
      stack.push({ block });
    }
    for (const child of node.childNodes.toReversed()) stack.push({ node: child, hidden: hides });
  }
  const page = blocks.map((block) => visible(block));
  return visible(page.join(' ')) === whole.text ? page : undefined;
}

/** The approved occurrence's place, read from the one line the envelope let change. */
export function occurrenceOf(
  change: ProposedChange,
  target: CorrectionTarget,
): Occurrence | undefined {
  const [file] = change.files;
  const before = (file?.before ?? '').split('\n');
  const after = (file?.after ?? '').split('\n');
  const index = before.findIndex((line, at) => line !== after[at]);
  const line = before[index] ?? '';
  const end = (offset: number) => offset + target.word.length;
  const at = wordOffsets(line, target.word).find(
    (offset) =>
      line.slice(0, offset) + target.replacement + line.slice(end(offset)) === after[index],
  );
  if (at === undefined || file === undefined) return undefined;
  before[index] = line.slice(0, at) + MARK + line.slice(end(at));
  const page = rendered(before.join('\n'));
  const block = page?.findIndex((text) => text.includes(MARK)) ?? -1;
  if (page === undefined || block < 0) return undefined;
  const joined = visible(page.join(' '));
  const showing = (word: string) => joined.replace(MARK, () => word);
  // The marker stands for the word only where the page shows the word there, and the
  // replacement there once changed: never inside a reference, nor a mark the page shows itself.
  const shows = (html: string, word: string) => {
    const blocks = rendered(html);
    return blocks !== undefined && visible(blocks.join(' ')) === showing(word);
  };
  if (joined.split(MARK).length !== 2) return undefined;
  if (!shows(file.before ?? '', target.word) || !shows(file.after ?? '', target.replacement))
    return undefined;
  const [left = '', right = ''] = page[block]?.split(MARK) ?? [];
  const near = { left: nearLeft(left), right: nearRight(right) };
  if (near.left === undefined || near.right === undefined) return undefined;
  const where = { left: near.left, right: near.right };
  // Ranked on the whole page, as the live check ranks it, the same before and after the change.
  const spot = joined.indexOf(MARK) - where.left.length;
  const words = [target.word, target.replacement];
  const rank = (word: string) =>
    equals(showing(word), where, words).findIndex((one) => one.at === spot && one.word === word);
  const ranked = rank(target.word);
  return ranked >= 0 && ranked === rank(target.replacement)
    ? { ...where, index: ranked }
    : undefined;
}

// How much of its block either side places the word: enough to tell it from its neighbours,
// short enough that counting its equals stays linear in the page.
const CONTEXT = 128;
/** The block's last CONTEXT characters before the word, cut after a space so word edges hold. */
function nearLeft(text: string): string | undefined {
  if (text.length <= CONTEXT) return text;
  const cut = text.slice(-CONTEXT);
  const space = cut.indexOf(' ');
  return space < 0 ? undefined : cut.slice(space + 1);
}
/** The block's first CONTEXT characters after the word, cut before a space. */
function nearRight(text: string): string | undefined {
  if (text.length <= CONTEXT) return text;
  const cut = text.slice(0, CONTEXT);
  const space = cut.lastIndexOf(' ');
  return space < 0 ? undefined : cut.slice(0, space);
}

/** Every match of the place holding one of `words`, in page order (ties by word). */
function equals(text: string, where: Occurrence, words: readonly string[]) {
  return words
    .flatMap((word) =>
      wordOffsets(text, where.left + word + where.right).map((at) => ({ at, word })),
    )
    .toSorted((a, b) => a.at - b.at || (a.word < b.word ? -1 : Number(a.word > b.word)));
}

/** The page's match of the approved occurrence, counted among its equals, holds `shown`. */
export function showsAt(
  text: string,
  where: Occurrence | undefined,
  shown: string,
  gone: string,
): boolean {
  if (where === undefined) return false;
  return equals(text, where, [shown, gone])[where.index ?? 0]?.word === shown;
}

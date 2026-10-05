// SPDX-License-Identifier: AGPL-3.0-only
//
// How the executable knows what its effect did, beyond the provider's answer:
// a send that may repeat an earlier one is read back through its seam first
// (broker contract 3.4), and a page is observed at the approved occurrence of
// the word, never by the word anywhere on it.

import type { ProviderResult } from '../call.ts';
import { wordOffsets, type CorrectionTarget, type ProposedChange } from './envelope.ts';
import { siteOperation } from './operations.ts';
import { served, visible } from './served-page.ts';

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
  /**
   * The word at each equal match on the served page, in order: before the change, or as read live
   * once seen live. Only a place calibrated on that page has it, and only such a place is observed.
   */
  readonly observed?: readonly string[];
  /** Seen live at this address: the page changed here when the correction landed, so it tracks the target. */
  readonly liveAt?: string;
}

const MARK = '\uE000';

/** Where on `line` the word was replaced to give `changed`: only an offset spanning every changed character. */
function replacedAt(line: string, changed: string, target: CorrectionTarget): number | undefined {
  let same = 0;
  while (same < line.length && line[same] === changed[same]) same += 1;
  let tail = 0;
  const shorter = Math.min(line.length, changed.length) - same;
  while (tail < shorter && line.at(-1 - tail) === changed.at(-1 - tail)) tail += 1;
  const end = (offset: number) => offset + target.word.length;
  return wordOffsets(line, target.word).find(
    (offset) =>
      offset <= same &&
      end(offset) >= line.length - tail &&
      line.slice(0, offset) + target.replacement + line.slice(end(offset)) === changed,
  );
}

/** The approved occurrence's place on the source's render, and the word at each equal there. */
function sourcePlace(
  change: ProposedChange,
  target: CorrectionTarget,
): { readonly where: Occurrence; readonly words: string[] } | undefined {
  const [file] = change.files;
  const before = (file?.before ?? '').split('\n');
  const after = (file?.after ?? '').split('\n');
  const index = before.findIndex((line, at) => line !== after[at]);
  const line = before[index] ?? '';
  const at = replacedAt(line, after[index] ?? '', target);
  if (at === undefined || file === undefined) return undefined;
  before[index] = line.slice(0, at) + MARK + line.slice(at + target.word.length);
  const page = served(before.join('\n'));
  const block = page?.findIndex((text) => text.includes(MARK)) ?? -1;
  if (page === undefined || block < 0) return undefined;
  const joined = visible(page.join(' '));
  const showing = (word: string) => joined.replace(MARK, () => word);
  // The marker stands for the word only where the page shows the word there, and the
  // replacement there once changed: never inside a reference, nor a mark the page shows itself.
  const shows = (html: string, word: string) => {
    const blocks = served(html);
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
  if (ranked < 0 || ranked !== rank(target.replacement)) return undefined;
  return {
    where: { ...where, index: ranked },
    words: equalsOf(showing(target.word), where, words),
  };
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

/** Text or a place past these is not searched (the search costs their product): no matches. */
const MOST_TEXT = 256 * 1024;
const MOST_PLACE = 4096;

/** Every match of the place holding one of `words`, in page order (ties by word). */
function equals(text: string, where: Pick<Occurrence, 'left' | 'right'>, words: readonly string[]) {
  const longest = Math.max(0, ...words.map((word) => word.length));
  if (text.length > MOST_TEXT || where.left.length + longest + where.right.length > MOST_PLACE) {
    return [];
  }
  return words
    .flatMap((word) =>
      wordOffsets(text, where.left + word + where.right).map((at) => ({ at, word })),
    )
    .toSorted((a, b) => a.at - b.at || (a.word < b.word ? -1 : Number(a.word > b.word)));
}

/** The words at the place's equal matches in `text`, among `words`, in page order. */
function equalsOf(
  text: string,
  where: Pick<Occurrence, 'left' | 'right'>,
  words: readonly string[],
): string[] {
  return equals(text, where, words).map((one) => one.word);
}

/** The approved occurrence's place on the source alone: never observed until it is calibrated. */
export function occurrenceOf(
  change: ProposedChange,
  target: CorrectionTarget,
): Occurrence | undefined {
  return sourcePlace(change, target)?.where;
}

/**
 * The place, calibrated on the served page captured before the change: kept only when that page
 * shows exactly the source's equal matches, so text the build drops or a layout adds never lines
 * the counts up (catalogue #953). Undefined is no place: never read live, so a person checks it.
 */
export function calibrated(
  change: ProposedChange,
  target: CorrectionTarget,
  preImage: string | undefined,
): Occurrence | undefined {
  const source = sourcePlace(change, target);
  if (source === undefined || preImage === undefined) return undefined;
  const observed = equalsOf(preImage, source.where, [target.word, target.replacement]);
  const same =
    observed[source.where.index ?? 0] === target.word &&
    observed.length === source.words.length &&
    observed.every((word, at) => word === source.words[at]);
  return same ? { ...source.where, observed } : undefined;
}

/**
 * The calibrated place read again. The change: the place holds `to` where it held `from`, every
 * other equal match as observed (the place as now read). Unchanged: not yet (undefined). Any other
 * page changed in a way no reading can tie to the target: `'unconfirmable'`, for a person.
 */
export function flipped(
  text: string,
  where: Occurrence | undefined,
  from: string,
  to: string,
): Occurrence | 'unconfirmable' | undefined {
  const observed = where?.observed;
  if (where === undefined || observed === undefined) return undefined;
  const index = where.index ?? 0;
  const found = equalsOf(text, where, [from, to]);
  const as = (expected: (at: number) => string | undefined) =>
    found.length === observed.length && found.every((word, at) => word === expected(at));
  if (observed[index] === from && as((at) => (at === index ? to : observed[at]))) {
    return { ...where, observed: found };
  }
  return as((at) => observed[at]) ? undefined : 'unconfirmable';
}

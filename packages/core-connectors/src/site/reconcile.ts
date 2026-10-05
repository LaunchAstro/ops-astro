// SPDX-License-Identifier: AGPL-3.0-only
//
// How the executable knows what its effect did, beyond the provider's answer:
// a send that may repeat an earlier one is read back through its seam first
// (broker contract 3.4), and a page is observed at the approved occurrence of
// the word, never by the word anywhere on it.

import type { ProviderResult } from '../call.ts';
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

/** Where the approved word sits: its rendered block either side, and its place among equal matches. */
export interface Occurrence {
  readonly left: string;
  readonly right: string;
  readonly index?: number;
  /**
   * The word at each equal match on the served page before the change, in order. Only a place
   * calibrated on that page has it, and only such a place is ever observed.
   */
  readonly observed?: readonly string[];
}

const BLOCK =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dt|figcaption|footer|h[1-6]|header|hr|li|main|nav|p|section|td|th)\b[^>]*>/giu;
const ENTITY = /&(?:#(\d{1,6})|#x([\da-f]{1,5})|(\w+));/giu;
const NAMED: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
const MARK = '\u0000';

/** Markup as the page shows it, block by block: inline tags dropped, entities decoded. */
const rendered = (html: string): string[] =>
  html.split(BLOCK).map((block) =>
    block
      .replaceAll(/<[^>]*>/gu, '')
      .replaceAll(ENTITY, (all, dec, hex, name) =>
        name === undefined ? String.fromCodePoint(Number(dec ?? `0x${hex}`)) : (NAMED[name] ?? all),
      )
      .replaceAll(/\s+/gu, ' ')
      .trim(),
  );

/** The words at the place's equal matches in `text`, among `words`, in page order. */
function equalsOf(text: string, where: Occurrence, words: readonly string[]): string[] {
  const found = words.flatMap((word) =>
    wordOffsets(text, where.left + word + where.right).map((at) => ({ at, word })),
  );
  return found.toSorted((a, b) => a.at - b.at).map(({ word }) => word);
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
  const end = (offset: number) => offset + target.word.length;
  const at = wordOffsets(line, target.word).find(
    (offset) =>
      line.slice(0, offset) + target.replacement + line.slice(end(offset)) === after[index],
  );
  if (at === undefined) return undefined;
  before[index] = line.slice(0, at) + MARK + line.slice(end(at));
  const page = rendered(before.join('\n'));
  const block = page.findIndex((text) => text.includes(MARK));
  const [left = '', right = ''] = page[block]?.split(MARK) ?? [];
  const words = [target.word, target.replacement];
  const where = {
    left,
    right,
    index: equalsOf(page.slice(0, block).join(' '), { left, right }, words).length,
  };
  return { where, words: equalsOf(page.join(' ').replace(MARK, target.word), where, words) };
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
 * the counts up (catalogue #953). Undefined is no place: the correction is never read live.
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
 * The page holds `shown` at the calibrated place and every other equal match as it was observed
 * before the change; an uncalibrated place never shows.
 */
export function showsAt(
  text: string,
  where: Occurrence | undefined,
  shown: string,
  gone: string,
): boolean {
  const observed = where?.observed;
  if (where === undefined || observed === undefined) return false;
  const index = where.index ?? 0;
  const found = equalsOf(text, where, [shown, gone]);
  return (
    found.length === observed.length &&
    found.every((word, at) => (at === index ? word === shown : word === observed[at]))
  );
}

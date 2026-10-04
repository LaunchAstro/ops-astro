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

/** Where the approved word sits: its text node's copy either side of it, whitespace collapsed. */
export interface Occurrence {
  readonly left: string;
  readonly right: string;
}

const collapse = (text = ''): string => text.replaceAll(/\s+/gu, ' ');

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
  if (at === undefined) return undefined;
  return {
    left: collapse(line.slice(0, at).split('>').at(-1)).trimStart(),
    right: collapse(line.slice(end(at)).split('<')[0]).trimEnd(),
  };
}

/** The page shows the approved occurrence holding `shown`, and not holding `gone`. */
export function showsAt(
  text: string,
  where: Occurrence | undefined,
  shown: string,
  gone: string,
): boolean {
  if (where === undefined) return false;
  const at = (word: string) => wordOffsets(text, `${where.left}${word}${where.right}`).length > 0;
  return at(shown) && !at(gone);
}

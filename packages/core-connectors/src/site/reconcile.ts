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

/**
 * A send that may repeat an earlier one. Landed is the effect's answer; only
 * positive proof that nothing landed lets `send` go; anything else stays
 * unknown and is never resent.
 */
export function reconciled<T>(
  back: ReadBack<T>,
  send: () => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> {
  if (back.state === 'landed') return Promise.resolve({ kind: 'ok', value: back.value });
  if (back.state === 'absent') return send();
  return Promise.resolve({ kind: 'unknown', code: 'RECONCILE_UNPROVEN' });
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

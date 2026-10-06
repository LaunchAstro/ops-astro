// SPDX-License-Identifier: AGPL-3.0-only
//
// The suite's fixed local tokenizer (CAPABILITY-SLICES section 15a): no paid
// call, no model, no dependency, the same count on every machine. It splits
// the way byte-pair tokenizers do at their coarsest and never merges further:
// each run of letters is one token per four characters, each run of digits
// one per three, each other visible character one, and whitespace nothing
// beyond the word it starts. A byte-pair tokenizer merges common words whole,
// so this counts at or above one on ordinary text: a budget met here is met
// there. It is a measure for waste, never a cap on correctness.

const PIECE = /\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu;

export function countTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(PIECE)) {
    if (/^\p{L}/u.test(piece)) tokens += Math.ceil(piece.length / 4);
    else if (/^\p{N}/u.test(piece)) tokens += Math.ceil(piece.length / 3);
    else tokens += 1;
  }
  return tokens;
}

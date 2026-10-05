// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a secret is spelled in a provider's answer, for custody's redaction
// (`custody-main.ts`): each character as itself, as JSON text writes it, or
// percent-escaped, in any mix, and the text with every such span cut out.
// It imports nothing, so custody's process loads no other code through it.

/** One way to spell one character of a secret; `fold` compares a percent escape's hex case-free. */
interface Spelling {
  readonly text: string;
  readonly fold: boolean;
}

/** A character as itself, as JSON text writes it, and as its UTF-8 bytes percent-escaped. */
export function spellingsOf(character: string): readonly Spelling[] {
  const json = JSON.stringify(character).slice(1, -1);
  const escaped = [...Buffer.from(character, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  return [
    { text: character, fold: false },
    ...(json === character ? [] : [{ text: json, fold: false }]),
    { text: escaped, fold: true },
  ];
}

const spelledAt = (text: string, offset: number, spelling: Spelling): boolean => {
  const part = text.slice(offset, offset + spelling.text.length);
  return spelling.fold ? part.toLowerCase() === spelling.text : part === spelling.text;
};

/**
 * Where the text spells the secret, each character in any of its spellings,
 * in any mix: one pass that keeps, for each text offset ahead, how far into
 * the secret a spelling reaching it has got and the earliest start that got
 * there (steps that meet go on alike). Nothing is retried, so the cost is the
 * text's length times the secret's, and every spelling stays reachable.
 */
export function spans(
  text: string,
  groups: readonly (readonly Spelling[])[],
): readonly (readonly [number, number])[] {
  if (groups.length === 0) return [];
  const ahead = new Map<number, Map<number, number>>();
  const found: [number, number][] = [];
  for (let offset = 0; offset <= text.length; offset += 1) {
    const here = ahead.get(offset) ?? new Map<number, number>();
    ahead.delete(offset);
    here.set(0, offset);
    for (const [step, start] of here) {
      if (step === groups.length) {
        found.push([start, offset]);
        continue;
      }
      for (const spelling of groups[step] ?? []) {
        if (!spelledAt(text, offset, spelling)) continue;
        const next = offset + spelling.text.length;
        const reached = ahead.get(next) ?? new Map<number, number>();
        if ((reached.get(step + 1) ?? next) > start) reached.set(step + 1, start);
        ahead.set(next, reached);
      }
    }
  }
  return found;
}

/** The text with every span, merged where they overlap, replaced by `[redacted]`. */
export function cut(text: string, found: readonly (readonly [number, number])[]): string {
  const merged: [number, number][] = [];
  for (const [start, end] of found.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = '';
  let from = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  return out + text.slice(from);
}

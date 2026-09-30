// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d: what the evidence bundle may carry of the text a run hands it. A case
// line's detail can quote an answer or a failed comparison, and those can
// carry a decision's note, a comment's body or a title: a person's words, and
// possibly a client's (Sol, reviews 1 and 2 on #164). So every string value
// of an embedded JSON field is replaced by its digest unless its key names an
// identifier, a state or the chain, or the value itself is an identifier, a
// digest, a time placeholder or a number. Plain and escaped quoting are both
// read. Every value withheld is remembered, so a last pass over the written
// bundle replaces any other copy of it, quoted or not.

import { createHash } from 'node:crypto';

/**
 * The decision payload's fields the bundle may show: identifiers, the
 * decision and the chain. Anything else, the note first, is written by a
 * person and may be a client's words, so it is withheld and named by its
 * digest (Sol, review 1 on #164).
 */
const SHOWN = new Set([
  'id',
  'by',
  'actor',
  'gate',
  'lineage',
  'version',
  'decision',
  'round',
  'seq',
  'link',
  'key',
  'evidence',
  'prev',
]);

/** Keys whose string values are identifiers, states or the chain, never a person's words. */
const PLAIN = new Set([
  ...SHOWN,
  'kind',
  'state',
  'status',
  'code',
  'outcome',
  'command',
  'audience',
  'surface',
  'refusal_code',
  'classified_cause',
  'drop_cause',
  'waiting_reason',
  'price_book',
  'provider',
  'model',
]);

/** A value that is itself an identifier, a digest, a placeholder or a number. */
const IDENTIFIER =
  /^(?:<id \d+>|<time>|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,64}|-?\d+(?:\.\d+)?)$/iu;

/** A JSON field with a string value, plainly quoted or escaped once inside another string. */
const FIELDS = [
  /"([A-Za-z_]\w*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/gu,
  /\\"([A-Za-z_]\w*)\\"(\s*:\s*)\\"((?:[^"\\]|\\[^"])*)\\"/gu,
];

export const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export function withheldLabel(value: string): string {
  return `withheld (sha256 ${digestOf(value).slice(0, 16)})`;
}

/**
 * Remember a withheld value in every spelling it could reappear in: as
 * captured, and decoded once and twice (`\\u0043` inside escaped JSON is a
 * `C` two decodings later), so the last pass catches a plain copy too.
 */
function hold(value: string, held: Set<string>): void {
  let spelling = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (spelling.length >= 4) held.add(spelling);
    try {
      const decoded: unknown = JSON.parse(`"${spelling}"`);
      if (typeof decoded !== 'string' || decoded === spelling) return;
      spelling = decoded;
    } catch {
      return;
    }
  }
}

/** Withholds the values in one piece of text, remembering each in `held`. */
export function withhold(text: string, held: Set<string>): string {
  let out = text;
  for (const [index, field] of FIELDS.entries()) {
    const quote = index === 0 ? '"' : '\\"';
    out = out.replaceAll(field, (whole, key: string, colon: string, value: string) => {
      if (PLAIN.has(key) || IDENTIFIER.test(value) || value.startsWith('withheld (sha256 ')) {
        return whole;
      }
      hold(value, held);
      return `${quote}${key}${quote}${colon}${quote}${withheldLabel(value)}${quote}`;
    });
  }
  return out;
}

/** The last pass: any other copy of a withheld value, however it is quoted or not. */
export function scrub(text: string, held: ReadonlySet<string>): string {
  let out = text;
  for (const value of [...held].toSorted((a, b) => b.length - a.length)) {
    const label = withheldLabel(value);
    out = out.replaceAll(value, label).replaceAll(JSON.stringify(value).slice(1, -1), label);
  }
  return out;
}

/** The approval as the bundle carries it: the row's exact bytes by digest, and its shown fields. */
export function approvalOf(
  approval: {
    readonly taskId: string;
    readonly decisionId: string;
    readonly decision: string;
    readonly action: string;
  },
  held: Set<string>,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(approval.action);
  } catch {
    payload = undefined;
  }
  const fields =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? Object.fromEntries(
          Object.entries(payload).map(([key, value]) =>
            SHOWN.has(key) ? [key, value] : [key, withheldValue(value, held)],
          ),
        )
      : 'withheld: the payload is not an object';
  const { taskId, decisionId, decision } = approval;
  return { taskId, decisionId, decision, actionSha256: digestOf(approval.action), action: fields };
}

/** A withheld payload value: its digest, and the value remembered for the last pass. */
function withheldValue(value: unknown, held: Set<string>): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length >= 4) held.add(text);
  return withheldLabel(text);
}

/**
 * A case detail as the bundle carries it: its digest, and nothing else (Sol,
 * reviews 3 and REV164D on #164). A detail is free text, and no token in it
 * is safe because of how it is spelled: a client's words can look like a
 * refusal code, an identifier or a path. What the bundle shows beside a case
 * comes from the facts the command's code typed separately (`CaseLine.facts`).
 */
export function digestDetail(detail: string): string {
  return `detail sha256 ${digestOf(detail).slice(0, 16)}`;
}

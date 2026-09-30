// SPDX-License-Identifier: AGPL-3.0-only
//
// What was asked for, read from the agent brief's own headings (MP-4-7,
// TA-11).
//
// **Read from the brief, never a second copy.** The facts are worked out from
// the brief each time it is drawn, so an edit to the brief is an edit to them
// and there is nothing to keep in step.
//
// **It matches the brief's own vocabulary and a few synonyms, and nothing
// else.** A brief that says "Objective" gets an Objective row; a brief that
// does not, does not. No first paragraph is taken to be the objective. A
// heading is a markdown heading (`#` to `####`) or a bold lead at the start of
// a line; its value is the rest of that line and the lines under it, up to the
// next heading. A heading with nothing under it gives no row.

export type BriefFactKey = 'Objective' | 'Definition of done' | 'Constraints' | 'Escalation';

export interface BriefFact {
  readonly key: BriefFactKey;
  readonly value: string;
}

const BRIEF_KEYS: readonly (readonly [BriefFactKey, RegExp])[] = [
  ['Objective', /^(objective|goal|aim)\b/iu],
  ['Definition of done', /^(done when|definition of done|acceptance|success)\b/iu],
  ['Constraints', /^(constraints?|limits?|rules|guardrails)\b/iu],
  ['Escalation', /^(escalat\w*|stop if|ask if|gates?)\b/iu],
];

const BOLD_LEAD = /^\s*(?:#{1,4}\s*)?\*\*([^*]+)\*\*\s*[—–:-]?\s*(.*)$/u;
const HEADING = /^\s*#{1,4}\s+(.+?)\s*[—–:]?\s*$/u;

interface Head {
  readonly line: number;
  readonly key: string;
  readonly rest: string;
}

function headsOf(lines: readonly string[]): readonly Head[] {
  const heads: Head[] = [];
  lines.forEach((text, line) => {
    const bold = BOLD_LEAD.exec(text);
    if (bold !== null) {
      heads.push({ line, key: (bold[1] ?? '').trim(), rest: (bold[2] ?? '').trim() });
      return;
    }
    const heading = HEADING.exec(text);
    if (heading !== null) heads.push({ line, key: (heading[1] ?? '').trim(), rest: '' });
  });
  return heads;
}

/** The brief's facts in the order it states them; empty when it names none. */
export function briefFacts(brief: string | null): readonly BriefFact[] {
  const source = brief ?? '';
  if (source.trim() === '') return [];
  const lines = source.split('\n');
  const heads = headsOf(lines);
  return heads.flatMap((head, index) => {
    const hit = BRIEF_KEYS.find(([, pattern]) => pattern.test(head.key));
    if (hit === undefined) return [];
    const end = heads[index + 1]?.line ?? lines.length;
    const value = [head.rest, ...lines.slice(head.line + 1, end)].join('\n').trim();
    return value === '' ? [] : [{ key: hit[0], value }];
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The breach drill's notices (C81): the published breach runbook's
// "Template: notice to affected people", filled from a privacy incident for
// the OAIC and each affected person at the recipient the operator names. It
// drafts; nothing here or anywhere sends a notice, because the owner decides
// what is sent (owner line 54). The OAIC's is the same template: the runbook
// says its statement carries the same content. A person's notice describes only
// what concerns that person, so the words the operator typed reach it with
// every other affected person's name and address taken out.

import type { PrivacyIncident } from './privacy-incidents.ts';

/** Who a notice is for, and where the operator says it goes. */
export interface NoticeRecipient {
  readonly name: string;
  readonly address: string;
}

export interface BreachNoticeInput {
  readonly incident: PrivacyIncident;
  readonly oaic: NoticeRecipient;
  readonly people: readonly NoticeRecipient[];
  /** What was done to contain it: only the owner and operator can say. */
  readonly containment: string;
  /** What the people affected should do. */
  readonly steps: string;
}

export interface BreachNotice extends NoticeRecipient {
  readonly to: 'oaic' | 'person';
  readonly subject: string;
  readonly body: string;
}

/** Operator text as one recipient's notice carries it. */
type Scrub = (text: string) => string;

const asTyped: Scrub = (text) => text;

/** The day a notice is dated on: the business's own, never the UTC day. */
const businessDay = new Intl.DateTimeFormat('en-CA', {
  // The clock the task screens date by (apps/web/src/screens/task/due-dates.ts).
  timeZone: 'Australia/Brisbane',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** What stands in a person's notice for any other affected person. */
const SOMEONE_ELSE = 'another person';

/** A letter or digit: a name matches only where neither side is one. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

const TEMPLATE_HEADING = /^##\s+template:\s*notice to affected people\s*$/iu;
const PLACEHOLDER = /`<([^`<>]*)>`/gu;

/** The template's subject and body lines, or `undefined` when the runbook has none. */
function templateOf(runbook: string): { subject: string; lines: readonly string[] } | undefined {
  const lines = runbook.split(/\r?\n/u);
  const start = lines.findIndex((line) => TEMPLATE_HEADING.test(line.trim()));
  if (start === -1) return undefined;
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    if (line.startsWith('>')) section.push(line.replace(/^> ?/u, ''));
  }
  const subjectAt = section.findIndex((line) => line.trim() !== '');
  const subject = /^subject:\s*(.+)$/iu.exec(section[subjectAt]?.trim() ?? '')?.[1];
  if (subject === undefined) return undefined;
  const body = section.slice(subjectAt + 1);
  while (body[0]?.trim() === '') body.shift();
  while (body.at(-1)?.trim() === '') body.pop();
  return body.length === 0 ? undefined : { subject, lines: body };
}

/** The value for one placeholder, or `undefined` for one the drill cannot fill. */
function valueFor(
  placeholder: string,
  input: BreachNoticeInput,
  recipient: NoticeRecipient,
  scrub: Scrub = asTyped,
): string | undefined {
  const key = placeholder.trim().toLowerCase();
  if (key === 'name') return recipient.name;
  // en-CA writes the day found as YYYY-MM-DD.
  if (key === 'date') return businessDay.format(input.incident.foundAt);
  if (key.startsWith('plain description')) return scrub(input.incident.whatHappened);
  if (key === 'kinds') return input.incident.informationKinds.join(', ');
  if (key.startsWith('containment')) return scrub(input.containment);
  if (key === 'steps') return scrub(input.steps);
  return undefined;
}

/** Whether every placeholder in the template is one the drill fills. */
function fillable(lines: readonly string[], input: BreachNoticeInput): boolean {
  return lines.every((line) =>
    [...line.matchAll(PLACEHOLDER)].every(
      (match) => valueFor(match[1] ?? '', input, input.oaic) !== undefined,
    ),
  );
}

/**
 * One pass over the template: a value is never searched again, so words an
 * operator typed that look like a placeholder stay as typed. A value ending in
 * a full stop right before the template's own loses its own.
 */
function fill(
  line: string,
  input: BreachNoticeInput,
  recipient: NoticeRecipient,
  scrub: Scrub,
): string {
  return line.replace(PLACEHOLDER, (_match, name: string, offset: number) => {
    const value = valueFor(name, input, recipient, scrub) ?? '';
    const next = line.charAt(offset + name.length + 4);
    return next === '.' && value.endsWith('.') ? value.slice(0, -1) : value;
  });
}

/**
 * For each person, the operator's text with every affected person's name and
 * address but that person's own read as "another person": as a whole word, in
 * any case, the longest first. Each text is split on the names once, so 500
 * people cost one search per text, not one per person.
 */
function othersOut(input: BreachNoticeInput): (person: NoticeRecipient) => Scrub {
  const words = [...new Set(input.people.flatMap((person) => [person.name, person.address]))]
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '')
    .toSorted((a, b) => b.length - a.length);
  const texts = [input.incident.whatHappened, input.containment, input.steps];
  // The names found sit at the odd places.
  const pieces = new Map(texts.map((text) => [text, splitOnNames(text, words)]));
  return (person) => {
    const own = new Set([person.name, person.address].map((word) => word.trim().toLowerCase()));
    return (text) =>
      (pieces.get(text) ?? [text])
        .map((piece, at) => (at % 2 === 1 && !own.has(piece.toLowerCase()) ? SOMEONE_ELSE : piece))
        .join('');
  };
}

/**
 * `text` split on whole-word, any-case matches of `words` (lowercase, longest
 * first), each match kept as its own piece at an odd index, as a split on a
 * pattern with one group gives. A scan, not a pattern built from the names.
 */
function splitOnNames(text: string, words: readonly string[]): string[] {
  const pieces: string[] = [];
  let from = 0;
  let at = 0;
  while (at < text.length) {
    const word =
      at > 0 && WORD_CHAR.test(text.charAt(at - 1)) ? undefined : nameAt(text, at, words);
    if (word === undefined) {
      at += 1;
      continue;
    }
    pieces.push(text.slice(from, at), text.slice(at, at + word.length));
    at += word.length;
    from = at;
  }
  pieces.push(text.slice(from));
  return pieces;
}

/** The longest of `words` that `text` holds at `at` as a whole word, in any case. */
function nameAt(text: string, at: number, words: readonly string[]): string | undefined {
  return words.find(
    (word) =>
      text.slice(at, at + word.length).toLowerCase() === word &&
      !WORD_CHAR.test(text.charAt(at + word.length)),
  );
}

/**
 * The notices, the OAIC's first and then one per person in the order given,
 * or `undefined` when the runbook has no template or one with a placeholder
 * the drill cannot fill: a notice with a hole in it is never drafted.
 */
export function draftBreachNotices(
  runbook: string,
  input: BreachNoticeInput,
): readonly BreachNotice[] | undefined {
  const template = templateOf(runbook);
  if (template === undefined || !fillable([template.subject, ...template.lines], input)) {
    return undefined;
  }
  const { subject, lines } = template;
  const draft = (
    to: BreachNotice['to'],
    recipient: NoticeRecipient,
    scrub: Scrub,
  ): BreachNotice => ({
    to,
    name: recipient.name,
    address: recipient.address,
    // A value typed with a line break still leaves the subject one line.
    subject: fill(subject, input, recipient, scrub).replaceAll(/\r\n|[\r\n]/gu, ' '),
    body: lines.map((line) => fill(line, input, recipient, scrub)).join('\n'),
  });
  const scrubFor = othersOut(input);
  return [
    draft('oaic', input.oaic, asTyped),
    ...input.people.map((person) => draft('person', person, scrubFor(person))),
  ];
}

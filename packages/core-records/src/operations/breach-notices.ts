// SPDX-License-Identifier: AGPL-3.0-only
//
// The breach drill's notices (C81): the published breach runbook's
// "Template: notice to affected people", filled from a privacy incident for
// the OAIC and each affected person at the recipient the operator names. It
// drafts; nothing here or anywhere sends a notice, because the owner decides
// what is sent (owner line 54). The OAIC's is the same template: the runbook
// says its statement carries the same content.

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
): string | undefined {
  const key = placeholder.trim().toLowerCase();
  if (key === 'name') return recipient.name;
  // The day found, as the record holds it (UTC).
  if (key === 'date') return input.incident.foundAt.toISOString().slice(0, 10);
  if (key.startsWith('plain description')) return input.incident.whatHappened;
  if (key === 'kinds') return input.incident.informationKinds.join(', ');
  if (key.startsWith('containment')) return input.containment;
  if (key === 'steps') return input.steps;
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
function fill(line: string, input: BreachNoticeInput, recipient: NoticeRecipient): string {
  return line.replace(PLACEHOLDER, (_match, name: string, offset: number) => {
    const value = valueFor(name, input, recipient) ?? '';
    const next = line.charAt(offset + name.length + 4);
    return next === '.' && value.endsWith('.') ? value.slice(0, -1) : value;
  });
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
  if (template === undefined || !fillable(template.lines, input)) return undefined;
  const { subject, lines } = template;
  const draft = (to: BreachNotice['to'], recipient: NoticeRecipient): BreachNotice => ({
    to,
    name: recipient.name,
    address: recipient.address,
    subject,
    body: lines.map((line) => fill(line, input, recipient)).join('\n'),
  });
  return [draft('oaic', input.oaic), ...input.people.map((person) => draft('person', person))];
}

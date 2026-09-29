// SPDX-License-Identifier: AGPL-3.0-only
//
// Reading the tracker files (API-5): the upstream skills' tracker docs, the
// Ops Astro one and the spec's mapping table, as the plain Markdown they are.
// A section is the text under its `## ` heading; an operation is a bullet
// `- **Label**: ...`; a CLI call is a backtick span that starts `pnpm cli `.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT: string = join(import.meta.dirname, '..', '..');
export const TRACKER_FILE = 'docs/agents/issue-tracker-ops-astro.md';
export const SPEC_SNAPSHOT = 'tests/cli/api-5-spec-mapping.md';
export const UPSTREAM = '.claude/skills/setup-matt-pocock-skills';

export const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
export const sha256 = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, path)))
    .digest('hex');

/** The text under `## <heading>`, up to the next `## `; empty when there is none. */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

export interface Operation {
  readonly label: string;
  readonly text: string;
}

/** Each `- **Label**: text` bullet, the text running to the next bullet. */
export function operations(text: string): readonly Operation[] {
  const found: Operation[] = [];
  for (const line of text.split('\n')) {
    const match = /^- \*\*(.+?)\*\*:?\s*(.*)$/u.exec(line);
    if (match !== null) found.push({ label: match[1] as string, text: match[2] as string });
    else if (found.length > 0 && line.startsWith('  ')) {
      const last = found.pop() as Operation;
      found.push({ label: last.label, text: `${last.text} ${line.trim()}` });
    }
  }
  return found;
}

/** The `pnpm cli ...` calls in a text, without the backticks. */
export const cliCalls = (text: string): readonly string[] =>
  [...text.matchAll(/`(pnpm cli [^`]+)`/gu)].map((match) => match[1] as string);

/** A command line split as a shell would: words, single and double quotes. */
export function words(line: string): readonly string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === ' ') {
      if (started || current !== '') out.push(current);
      current = '';
      started = false;
    } else current += char;
  }
  if (started || current !== '') out.push(current);
  return out;
}

/** The rows of the first Markdown table in a text, each cell trimmed, the rule line dropped. */
export function tableRows(text: string): readonly string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|'));
  if (start === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break;
    if (/^\|[\s|:-]+\|$/u.test(line)) continue;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
        .join(' | '),
    );
  }
  return rows;
}

/** The first row where two tables differ, or null when they match line for line. */
export function firstDifference(
  left: readonly string[],
  right: readonly string[],
): { readonly line: number; readonly left: string; readonly right: string } | null {
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    if (left[at] !== right[at])
      return { line: at + 1, left: left[at] ?? '(none)', right: right[at] ?? '(none)' };
  }
  return null;
}

/** `ref=<id>` pairs a chart's or a graduation's one line lists. */
export const madeIds = (out: string): Record<string, string> =>
  Object.fromEntries(
    [...out.matchAll(/\b([\w-]+)=([0-9a-f-]{36})\b/gu)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );

// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's compact output (API-3): terse text by default, minimal JSON
// on request, never a schema or boilerplate. It shapes what the API answered
// and decides nothing: a refusal is the server's, put in one plain line.

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only the fields named, in the order named; every field when none are. */
export function select(value: Json, fields: readonly string[] | undefined): Json {
  if (fields === undefined) return value;
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]));
}

/** A scalar, or a nested value on one line. */
function inline(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.replaceAll(/\s+/gu, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((one) => inline(one)).join(', ');
  return Object.values(value as Json)
    .map((one) => inline(one))
    .join(' ');
}

/** One record as `key: value` lines; a list of records as one line each under its key. */
export function text(value: Json): string {
  const lines: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (Array.isArray(field) && field.some((item) => isObject(item))) {
      lines.push(`${key} (${String(field.length)}):`);
      for (const item of field) lines.push(`- ${inline(item)}`);
    } else lines.push(`${key}: ${inline(field)}`);
  }
  return lines.join('\n');
}

/** A page: one line per item, then the next token when there is one. */
export function pageText(items: readonly Json[], next: string | null): string {
  const lines = items.map((item) =>
    Object.values(item)
      .map((one) => inline(one))
      .join(' | '),
  );
  if (next !== null) lines.push(`next: ${next}`);
  return lines.join('\n');
}

/** Codes about who may act, which name the key the caller lacks. */
const AUTHORITY = /GRANT|PERMIT|DELEGATION|AUTH|AGENT/u;

/**
 * A refusal in one line: the code, the key it needs where it is about
 * authority, and the server's first fix in plain words.
 */
export function refusalLine(body: Json, key: string): string {
  const code = typeof body['code'] === 'string' ? body['code'] : 'REFUSED';
  const names = Array.isArray(body['names']) ? (body['names'] as unknown[]) : [];
  const named = names.find((name) => typeof name === 'string' && /^[a-z_]+:[a-z_]+$/u.test(name));
  const needs = AUTHORITY.test(code) ? ` You need ${typeof named === 'string' ? named : key}.` : '';
  const fixes = Array.isArray(body['fixes']) ? (body['fixes'] as unknown[]) : [];
  const fix = typeof fixes[0] === 'string' ? ` ${fixes[0]}` : '';
  return `refused ${code}.${needs}${fix}`.replaceAll(/\s+/gu, ' ').trim();
}

/** A write's result in one line: what ran, the record it touched and its revision. */
export function writeLine(command: string, body: Json): string {
  const id = typeof body['recordId'] === 'string' ? ` ${body['recordId']}` : '';
  const revision = typeof body['revision'] === 'number' ? ` r${String(body['revision'])}` : '';
  return `ok ${command}${id}${revision}`;
}

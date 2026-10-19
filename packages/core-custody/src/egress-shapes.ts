// SPDX-License-Identifier: AGPL-3.0-only
//
// The shapes a destination's extras (`egress-routes.ts`) are read as, each
// refused whole when malformed: fixed headers custody may set, a template
// route's answer fields, and a PATCH route's body names.

import type { Fields } from './egress-answer.ts';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A lower-case token: one spelling per name, so no two can collide by case. */
const HEADER_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
/** Visible ASCII, inner spaces only: no CR, LF, tab or other control byte. */
const HEADER_VALUE = /^[!-~](?:[ -~]{0,254}[!-~])?$/u;
/** Names custody or the transport owns: the credential, framing and routing. */
const RESERVED = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
  'expect',
]);
/** A declared field: dotted names, as the catalogue writes them. */
const FIELD = /^[A-Za-z0-9_$]{1,64}(?:\.[A-Za-z0-9_$]{1,64}){0,7}$/u;
const KINDS: ReadonlySet<unknown> = new Set(['string', 'number', 'boolean']);
/** A schema of more fields would make custody's echo check (`withholds`) too costly. */
const MOST_FIELDS = 4;

export function fieldsOf(value: unknown): Fields | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const valid =
    entries.length <= MOST_FIELDS &&
    entries.every(([name, kind]) => FIELD.test(name) && KINDS.has(kind));
  return valid ? (Object.fromEntries(entries) as Fields) : undefined;
}

export function headersOf(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const valid = entries.every(
    ([name, text]) =>
      HEADER_NAME.test(name) &&
      !RESERVED.has(name) &&
      typeof text === 'string' &&
      HEADER_VALUE.test(text),
  );
  return valid ? Object.fromEntries(entries as [string, string][]) : undefined;
}

/** A PATCH's body names: one or more plain names, none twice. */
export function bodyOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const names = value.filter(
    (name): name is string => typeof name === 'string' && FIELD.test(name),
  );
  return names.length === value.length && new Set(names).size === names.length ? names : undefined;
}

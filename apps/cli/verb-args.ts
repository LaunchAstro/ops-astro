// SPDX-License-Identifier: AGPL-3.0-only
//
// The verb CLI's words and flags (API-3, API-5): one row's shape and the
// helpers that turn its flags into the owning command's body. A malformed
// flag is a usage error before any request; every rule about the body itself
// stays the server's.

import type { CommandName } from '../../packages/core-wire/src/index.ts';

export type Flags = Readonly<Record<string, string | true>>;
export type Body = Record<string, unknown>;

export interface VerbRow {
  readonly verb: string;
  readonly command: CommandName;
  /** The words after the verb, as the help shows them. */
  readonly usage: string;
  readonly body: (id: string | undefined, flags: Flags) => Body;
  /** Words a write's one line adds after its id and revision (ids it made). */
  readonly more?: (detail: Readonly<Record<string, unknown>>) => string;
}

export class UsageError extends Error {}

const DETAILS = new Set(['brief', 'standard', 'full']);

export const need = (flags: Flags, name: string): string => {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is needed`);
  return value;
};
export const maybe = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === 'string' ? flags[name] : undefined;
export const target = (id: string | undefined): string => {
  if (id === undefined) throw new UsageError('name the task by its id');
  return id;
};
export const revision = (flags: Flags): number => {
  const value = Number(need(flags, 'revision'));
  if (!Number.isInteger(value)) throw new UsageError('--revision is a whole number');
  return value;
};
export const detail = (flags: Flags): string => {
  const value = maybe(flags, 'detail') ?? 'standard';
  if (!DETAILS.has(value)) throw new UsageError('--detail is brief, standard or full');
  return value;
};
export const fields = (flags: Flags): Body => {
  const title = maybe(flags, 'title');
  const description = maybe(flags, 'description');
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
};
export const optional = (key: string, value: string | undefined): Body =>
  value === undefined ? {} : { [key]: value };
/** A comma list of ids; empty when the flag is absent or blank. */
export const idList = (flags: Flags, name: string): string[] =>
  (maybe(flags, name) ?? '').split(',').filter((one) => one !== '');
/** A flag holding a JSON list, checked to be a list; its entries are the server's to check. */
export const jsonList = (flags: Flags, name: string): Body => {
  const value = maybe(flags, name);
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(`--${name} is a JSON list`);
  }
  if (!Array.isArray(parsed)) throw new UsageError(`--${name} is a JSON list`);
  return { [name.replaceAll(/-(\w)/gu, (_all, letter: string) => letter.toUpperCase())]: parsed };
};

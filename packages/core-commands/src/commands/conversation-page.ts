// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's added page (CS-7.31, "Add page to context"), as an operand:
// `conversation.set_scope` sets it on a conversation, and `conversation.start`
// takes it with the first message (#1467), so the first question is asked
// with it. One check and one refusal for both. Its address is a page of this
// product: one leading slash, never two and never a slash then a backslash,
// printable ASCII without a backslash, at most 300 characters. Migration 0094
// refuses the same rows, as the backstop.

import { refuseCommand, type CommandRefusal } from './refusal.ts';

const ADDRESS_LIMIT = 300;
const SHOWS_LIMIT = 200;
const IN_PRODUCT = /^\/(?![/\\])[!-~]*$/u;
// eslint-disable-next-line no-control-regex -- the control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

export interface Page {
  readonly address: string;
  readonly shows: string;
}

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ADDRESS_LIMIT &&
  IN_PRODUCT.test(value) &&
  !value.includes('\\');

// `bounded` in `conversation-start-fields.ts`, which imports this file, so it is not imported back.
const isShows = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  value.length <= SHOWS_LIMIT &&
  !CONTROL.test(value);

/** The page, `null` to clear it, or undefined when it will not do. */
export function pageOf(value: unknown): Page | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined || Array.isArray(value)) return undefined;
  const { address, shows, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isAddress(address) || !isShows(shows)) return undefined;
  return { address, shows };
}

export const PAGE_INVALID: CommandRefusal = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['page'],
  [
    `Send page as {"address":<a path of this product, starting with one slash, at most ${String(ADDRESS_LIMIT)} printable characters>,"shows":<what the page shows, 1 to ${String(SHOWS_LIMIT)} characters>}, or null to clear it.`,
  ],
);

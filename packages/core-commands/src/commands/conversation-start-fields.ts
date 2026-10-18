// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.start`'s operands (AW-03), checked before anything is read or
// locked, moved whole from `conversations.ts` to keep it under its line cap.
// Each field that will not do is refused by name. The page added before the
// first message (#1467) is checked as `conversation.set_scope` checks it,
// with its refusal.

import { PAGE_INVALID, pageOf, type Page } from './conversation-page.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

export const BODY_LIMIT = 20_000;
export const TITLE_LIMIT = 120;
const SUBJECT_LIMIT = 200;

export const bounded = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= limit;

const optionalBounded = (value: unknown, limit: number): boolean =>
  value === undefined || value === null || bounded(value, limit);

export interface Scope {
  readonly kind: 'task';
  readonly id: string;
}

function scopeOf(value: unknown): Scope | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, id, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || kind !== 'task' || !isIdentifier(id)) return undefined;
  return { kind, id };
}

export interface StartFields {
  readonly body: unknown;
  readonly title?: unknown;
  readonly subject?: unknown;
  readonly scope?: unknown;
  /** The model chosen before the first message (CS-7.30): an offered one, or absent for the default. */
  readonly model?: unknown;
  /** The page added before the first message (#1467), as `conversation.set_scope` takes it. */
  readonly page?: unknown;
}

/** The first message's fields, refused by name; undefined when they will do. */
function startRefusal(
  fields: StartFields,
  scope: Scope | null | undefined,
): CommandRefusal | undefined {
  const invalid = [
    ...(bounded(fields.body, BODY_LIMIT) ? [] : ['body']),
    ...(optionalBounded(fields.title, TITLE_LIMIT) ? [] : ['title']),
    ...(optionalBounded(fields.subject, SUBJECT_LIMIT) ? [] : ['subject']),
    ...(scope === undefined ? ['scope'] : []),
  ];
  if (invalid.length === 0) return undefined;
  return refuseCommand('FIELD_VALUE_INVALID', invalid, [
    `Send the first message as body, 1 to ${BODY_LIMIT} characters; a title of at most ${TITLE_LIMIT} and a subject of at most ${SUBJECT_LIMIT} if any; and a scope as {"kind":"task","id":<task id>} or nothing.`,
  ]);
}

/** The start's scope and page, or the refusal naming the fields that will not do. */
export function startFieldsOf(
  fields: StartFields,
): { readonly scope: Scope | null; readonly page: Page | null } | CommandRefusal {
  const scope = scopeOf(fields.scope);
  const invalid = startRefusal(fields, scope);
  if (invalid !== undefined) return invalid;
  const page = fields.page === undefined ? null : pageOf(fields.page);
  if (page === undefined) return PAGE_INVALID;
  return { scope: scope ?? null, page };
}

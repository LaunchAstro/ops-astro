// SPDX-License-Identifier: AGPL-3.0-only
//
// `record.create` (C41-A, U38's one record-create command, RC-13): a new
// record of a type this command knows. Only `client` today, with its name,
// made as `client.create` makes one (0055's `clients`, the row a task's
// `client` link and a party-scoped grant name); the CRM grows the client's
// fields and the command the types it creates. The caller's `record:write`
// across the business was checked by the envelope. The applied detail carries
// ids alone, so a client's name never reaches the audit chain.

import {
  CLIENT_NAME_MOST,
  createClient,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const CLIENT_TYPE_KEY = 'client';

const FIXES: Readonly<Record<string, string>> = {
  type: 'Send type as client, the one record type this command creates today.',
  fields: `Send fields as { name }: the client name, 1 to ${String(CLIENT_NAME_MOST)} characters.`,
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [FIXES[field] ?? '']));

// jsonb and Postgres text refuse a NUL, and jsonb a lone surrogate.
const UNSTORABLE = /[\0\p{Surrogate}]/u;

export function textOf(value: unknown, most: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > most || UNSTORABLE.test(text)) return null;
  return text;
}

/** A new client. Only `client` today; the CRM adds its fields later. */
export async function createRecord(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly type?: unknown; readonly fields: Readonly<Record<string, unknown>> },
): Promise<HandlerOutcome> {
  if (request.type !== CLIENT_TYPE_KEY) return invalid('type');
  const keys = Object.keys(request.fields);
  const name = textOf(request.fields['name'], CLIENT_NAME_MOST);
  if (keys.length !== 1 || name === null) return invalid('fields');
  const made = await createClient(tx, name, context.session.actorId);
  if (!made.ok) return refused(made.refusal);
  return applied(made.value, null, { recordId: made.value, type: CLIENT_TYPE_KEY });
}

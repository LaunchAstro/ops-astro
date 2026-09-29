// SPDX-License-Identifier: AGPL-3.0-only
//
// `record.create` (C41-A, U38's shared record-create command): a new record
// of a type this command knows. Only `client` today, with its name; the CRM
// grows the client's fields and the command the types it creates. The
// caller's `record:write` across the business was checked by the envelope.

import { randomUUID } from 'node:crypto';
import {
  CLIENT_TYPE_KEY,
  installClientType,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const FIXES: Readonly<Record<string, string>> = {
  type: 'Send type as client, the one record type this command creates today.',
  fields: 'Send fields as { name }: the client name, 1 to 200 characters.',
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

/** A new client record. Only `client` today; the CRM adds its fields later. */
export async function createRecord(
  tx: TenantQuery,
  _context: CommandContext,
  request: { readonly type?: unknown; readonly fields: Readonly<Record<string, unknown>> },
): Promise<HandlerOutcome> {
  if (request.type !== CLIENT_TYPE_KEY) return invalid('type');
  const keys = Object.keys(request.fields);
  const name = textOf(request.fields['name'], 200);
  if (keys.length !== 1 || name === null) return invalid('fields');
  const clientTypeId = await installClientType(tx);
  const id = randomUUID();
  const rows = await tx.query<{ readonly revision: string }>(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)
     returning revision::text as revision`,
    [tx.businessId, id, clientTypeId, { name }],
  );
  return applied(id, Number(rows[0]?.revision ?? 1), { recordId: id, type: CLIENT_TYPE_KEY });
}

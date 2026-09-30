// SPDX-License-Identifier: AGPL-3.0-only
//
// `privacy.set_data_class` (C81): one row of the data-class register the
// privacy policy reads, under `privacy:manage` and never an agent's. The row is
// matched by the class's name in any letter case, and every field is sent each
// time, so a change is always the whole row and the envelope audits each one.
// A class the business no longer holds is set `inUse: false` and kept.
//
// A class missing its purpose, disclosures, retention or deletion is refused
// `FIELD_VALUE_INVALID` naming the field alone: a refusal never repeats what
// was sent. The applied detail carries the row's id and nothing else.

import { setDataClass } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request = CommandRequest & { readonly command: 'privacy.set_data_class' };

/** The longest each text field may be, as the table's checks hold it. */
const MOST = {
  dataClass: 120,
  purpose: 2000,
  disclosures: 2000,
  retention: 2000,
  deletion: 2000,
} as const;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  dataClass: [`Name the class in 1 to ${String(MOST.dataClass)} characters.`],
  purpose: [`Say why it is held in 1 to ${String(MOST.purpose)} characters.`],
  disclosures: [
    `Say to whom it is normally disclosed in 1 to ${String(MOST.disclosures)} characters.`,
  ],
  retention: [`Say how long it is kept in 1 to ${String(MOST.retention)} characters.`],
  deletion: [`Say how it is deleted in 1 to ${String(MOST.deletion)} characters.`],
  inUse: ['Send true while the business holds this class, or false.'],
};

function text(value: unknown, most: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= most ? trimmed : undefined;
}

export async function setClass(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
): Promise<HandlerOutcome> {
  const invalid = (field: string) =>
    refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

  const fields: Record<keyof typeof MOST, string> = {
    dataClass: '',
    purpose: '',
    disclosures: '',
    retention: '',
    deletion: '',
  };
  for (const field of Object.keys(MOST) as (keyof typeof MOST)[]) {
    const value = text(request[field], MOST[field]);
    if (value === undefined) return invalid(field);
    fields[field] = value;
  }
  const { inUse } = request;
  if (typeof inUse !== 'boolean') return invalid('inUse');

  const { id } = await setDataClass(tx, { ...fields, inUse }, context.session.actorId);
  return applied(id, null, { dataClassId: id });
}

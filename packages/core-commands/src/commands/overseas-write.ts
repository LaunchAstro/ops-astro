// SPDX-License-Identifier: AGPL-3.0-only
//
// `privacy.set_overseas_service` (C81, SP-25): one row of the overseas-services
// register the privacy policy reads, under `privacy:manage` and never an
// agent's. The row is matched by the service's name in any letter case, and
// every field is sent each time, so a change is always the whole row and the
// envelope audits each one. A service the installation stops using is set
// `inUse: false` and kept.
//
// Every field is refused `FIELD_VALUE_INVALID` naming the field alone: a
// refusal never repeats what was sent. The applied detail carries the row's id
// and nothing else.

import { setOverseasService } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request = CommandRequest & { readonly command: 'privacy.set_overseas_service' };

/** The longest each text field may be, as the table's checks hold it. */
const MOST = {
  service: 120,
  receives: 2000,
  where: 1000,
  trainsOnIt: 1000,
  contract: 1000,
} as const;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  service: [`Name the service in 1 to ${String(MOST.service)} characters.`],
  receives: [`Say what it receives in 1 to ${String(MOST.receives)} characters.`],
  where: [`Say where it is stored in 1 to ${String(MOST.where)} characters.`],
  trainsOnIt: [`Say whether it trains on it in 1 to ${String(MOST.trainsOnIt)} characters.`],
  contract: [`Name the contract in 1 to ${String(MOST.contract)} characters.`],
  toConfirm: ['Send true while any of this row is still to confirm, or false.'],
  inUse: ['Send true while the installation uses this service, or false.'],
};

function text(value: unknown, most: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= most ? trimmed : undefined;
}

export async function setService(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
): Promise<HandlerOutcome> {
  const invalid = (field: string) =>
    refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

  const service = text(request.service, MOST.service);
  if (service === undefined) return invalid('service');
  const receives = text(request.receives, MOST.receives);
  if (receives === undefined) return invalid('receives');
  const where = text(request.where, MOST.where);
  if (where === undefined) return invalid('where');
  const trainsOnIt = text(request.trainsOnIt, MOST.trainsOnIt);
  if (trainsOnIt === undefined) return invalid('trainsOnIt');
  const contract = text(request.contract, MOST.contract);
  if (contract === undefined) return invalid('contract');
  const { toConfirm, inUse } = request;
  if (typeof toConfirm !== 'boolean') return invalid('toConfirm');
  if (typeof inUse !== 'boolean') return invalid('inUse');

  const { id } = await setOverseasService(
    tx,
    { service, receives, where, trainsOnIt, contract, toConfirm, inUse },
    context.session.actorId,
  );
  return applied(id, null, { serviceId: id });
}

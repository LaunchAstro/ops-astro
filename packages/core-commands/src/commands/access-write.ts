// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 (CS-2.15): the client record and grants on Settings ▸ Access.
//
// - `client.create`, the tracked action `record created (client)` under
//   `record:write`: a client of this business by name.
// - `access.grant`, the tracked action `grant changed` under `access:manage`:
//   a person of this business given a catalogue key over the whole business
//   or one client of it.
// - `access.revoke`, the same tracked action: any live grant of the business
//   (`authority-controls.ts`, `revokeGrantOnAccess`).
//
// None is an agent's. Each field is refused `FIELD_VALUE_INVALID` naming the
// field alone: a refusal never repeats what was sent. The applied detail
// carries ids and nothing else, so a client's name never reaches the audit
// chain or the operation register.

import {
  CLIENT_NAME_MOST,
  createClient,
  grantAccess,
  isUuid,
  type Action,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { isGrantableKey, SELF_SCOPED_COLLECTIONS } from '../../../core-wire/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const ACTIONS: readonly string[] = [
  'read',
  'comment',
  'write',
  'assign',
  'decide',
  'share',
  'manage',
];

const FIXES: Readonly<Record<string, readonly string[]>> = {
  name: [`Name the client in 1 to ${String(CLIENT_NAME_MOST)} characters.`],
  holderId: ['Name the person who is to hold the grant by their identifier.'],
  clientId: ['Name one client by its identifier, or send null for the whole business.'],
  collection: ['Name a collection of the permission key catalogue.'],
  action: ['Name an action the permission key catalogue holds for that collection.'],
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

export async function createClientRecord(
  tx: TenantQuery,
  context: CommandContext,
  request: Request<'client.create'>,
): Promise<HandlerOutcome> {
  const { name } = request;
  if (typeof name !== 'string') return invalid('name');
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > CLIENT_NAME_MOST) return invalid('name');
  const made = await createClient(tx, trimmed, context.session.actorId);
  if (!made.ok) return refused(made.refusal);
  return applied(made.value, null, { clientId: made.value });
}

export async function grantOnAccess(
  tx: TenantQuery,
  context: CommandContext,
  request: Request<'access.grant'>,
): Promise<HandlerOutcome> {
  const { holderId, collection, action } = request;
  const clientId = request.clientId ?? null;
  if (typeof holderId !== 'string' || !isUuid(holderId)) return invalid('holderId');
  if (clientId !== null && (typeof clientId !== 'string' || !isUuid(clientId))) {
    return invalid('clientId');
  }
  if (typeof collection !== 'string' || SELF_SCOPED_COLLECTIONS.includes(collection)) {
    return invalid('collection');
  }
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return invalid('action');
  if (!isGrantableKey(collection, action)) {
    return invalid(hasAnyKey(collection) ? 'action' : 'collection');
  }
  const given = await grantAccess(
    tx,
    {
      personId: holderId.toLowerCase(),
      collection,
      action: action as Action,
      clientId: clientId === null ? null : clientId.toLowerCase(),
    },
    context.session.actorId,
  );
  if (!given.ok) return refused(given.refusal);
  return applied(given.value, null, { grantId: given.value });
}

/** Whether the catalogue holds any key on this collection. */
function hasAnyKey(collection: string): boolean {
  return ACTIONS.some((action) => isGrantableKey(collection, action));
}

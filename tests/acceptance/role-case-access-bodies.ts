// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for the client record and Settings ▸ Access
// (C32, C58), split from role-case-positive-body.ts to keep that file under
// the line limit, as role-case-privacy-bodies.ts is. The admin holds
// `record:write` and `access:manage`, as the owner does.

import { randomUUID } from 'node:crypto';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

type AccessCommand = 'client.create' | 'access.grant' | 'access.revoke' | 'access.end';

/** Clients made by the matrix, each under a name of its own (one name per business). */
let clientsMade = 0;
const nextClientName = (): string =>
  `A made-up client ${String((clientsMade += 1))} ${randomUUID()}`;

/** A client of the context's business, made by its admin (C32). */
export async function madeClient(context: BodyContext): Promise<string> {
  const made = await context.asPerson('client.create', { name: nextClientName() });
  if (made.code !== 'ok') throw new Error(`matrix: client.create refused ${made.code}`);
  return String((made.body['detail'] as Record<string, unknown>)['clientId']);
}

export async function accessBody(name: AccessCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    // C32: `record:write`, a name no other call has used.
    case 'client.create':
      return { body: { name: nextClientName() } };
    // C32: `access:manage`. The key is one the member already holds over
    // the whole business, so the answer is that grant and no caller's
    // holdings change under the cases that read them.
    case 'access.grant':
      return {
        body: { holderId: context.assigneePersonId, collection: 'task', action: 'read' },
      };
    // C32: a grant the admin has just given over one client, revoked. The
    // member already holds the same key over the whole business.
    case 'access.revoke': {
      const given = await context.asPerson('access.grant', {
        holderId: context.assigneePersonId,
        collection: 'task',
        action: 'read',
        clientId: await madeClient(context),
      });
      if (given.code !== 'ok') throw new Error(`matrix: access.grant refused ${given.code}`);
      return { body: { grantId: (given.body['detail'] as Record<string, unknown>)['grantId'] } };
    }
    // C58: `access:manage`, ending a member made for the case, so no
    // caller's standing changes under the cases that read it.
    case 'access.end':
      if (context.freshMember === undefined) return { exception: 'no member maker here' };
      return { body: { holderId: await context.freshMember() } };
  }
}

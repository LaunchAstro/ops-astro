// SPDX-License-Identifier: AGPL-3.0-only
//
// The records R4's external party is tested against (`external-party.test.ts`):
// one task the admin will share, carrying a comment for each audience, and a
// sibling task the party must never learn about. Each is written through the
// real API as the admin, so no fixture row stands in for any of them.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer, Caller, World } from './world.ts';

export const TITLE = 'Quarterly retainer: draft for review';
export const DESCRIPTION = 'internal: client is behind on two invoices';
export const TEAM_NOTE = 'team only: do not tell the client about the margin';
export const CLIENT_NOTE = 'Hello, the draft is ready for your review.';
export const SIBLING_TITLE = 'Sibling task the client must never learn about';

/** One call on the person path, as the test file sends it. */
type As = (who: Caller, name: CommandName, body: Record<string, unknown>) => Promise<Answer>;

/** Writes the shared task, its two comments and the sibling, as the admin. */
export async function seedRecords(
  world: World,
  as: As,
  revisionOf: (recordId: string) => Promise<number>,
): Promise<{ readonly shared: string; readonly sibling: string }> {
  const made = await as(world.ada, 'task.create', {
    operationId: randomUUID(),
    fields: { title: TITLE, description: DESCRIPTION },
  });
  expect(made.code).toBe('ok');
  const shared = String(made.body['recordId']);
  for (const comment of [
    { body: TEAM_NOTE, audience: 'internal' },
    { body: CLIENT_NOTE, audience: 'client', commentType: 'client' },
  ]) {
    // eslint-disable-next-line no-await-in-loop -- the revision moves with each one
    const expectedRevision = await revisionOf(shared);
    // eslint-disable-next-line no-await-in-loop
    const written = await as(world.ada, 'task.comment', {
      operationId: randomUUID(),
      recordId: shared,
      expectedRevision,
      ...comment,
    });
    expect(written.code).toBe('ok');
  }
  const other = await as(world.ada, 'task.create', {
    operationId: randomUUID(),
    fields: { title: SIBLING_TITLE },
  });
  return { shared, sibling: String(other.body['recordId']) };
}

/**
 * The bodies item 3 sends for the writes the matrix gives no body, each naming a row of its
 * own kind. Moved from `external-party.test.ts` to keep that file under the line limit.
 */
export function revocationBodies(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return {
    'grant.revoke': { grantId: randomUUID() },
    'delegation.revoke': { delegationId: randomUUID() },
    // No person body either: it is the agent's (AW-01). Sent well formed,
    // naming a lease, so the answer is authority's.
    'model.call': {
      leaseId: randomUUID(),
      fence: 1,
      operation: 'model.replay_compose',
      fields: [],
    },
  };
}

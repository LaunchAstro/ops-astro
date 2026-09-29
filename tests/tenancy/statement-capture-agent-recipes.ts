// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's positive calls for the statement capture (`statement-capture-full.test.ts`):
// a pickup on the world's application, and the recipes for the operations
// `role-case-bodies.ts` answers with an exception. Split from
// `statement-capture-cases.ts` so each stays under the per-file cap.

import { type CommandName } from '../../packages/core-wire/src/surface.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { Harness } from '../acceptance/role-case-harness.ts';
import { type AgentRecipe, reservation, endLive } from './statement-capture-cases.ts';

/** A pickup on the world's application, so the captured call is only what follows it. */
async function pickedUp(harness: Harness): Promise<Record<string, unknown>> {
  await endLive(harness);
  const picked = await harness.asAgent('task.pickup', {
    reservationId: await reservation(harness),
  });
  if (picked.code !== 'ok') throw new Error(`capture: pickup refused ${picked.code}`);
  return picked.body['detail'] as Record<string, unknown>;
}

/**
 * The operations `role-case-bodies.ts` answers with an exception rather than a
 * body. Each is the positive call the matrix points elsewhere for, built from
 * the same journey its comment names. `task.pickup`, `task.heartbeat` and
 * `task.handback` left this list when person work became positive (EX-01):
 * the matrix now has a person body for each, and their agent calls are
 * captured separately below so the agent path stays covered.
 */
export const AGENT_RECIPES: Partial<Record<CommandName, AgentRecipe>> = {
  'delegation.revoke': async (harness) => {
    const picked = await pickedUp(harness);
    return { prefix: 'person', body: { delegationId: picked['delegationId'] } };
  },
  'grant.revoke': async (harness) => {
    // A grant of its own to take away, issued to `noah` so no other case
    // loses the authority it runs on. The revocation is the route.
    const { world } = harness;
    const grantId = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: world.noah.personId as string },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      });
      if (!issued.ok) throw new Error(`capture: grant refused ${issued.refusal.code}`);
      return issued.value;
    });
    return { prefix: 'person', body: { grantId } };
  },
};

/**
 * The agent's own call for the operations a person now performs too. The
 * person body is the positive case above; these keep the agent prefix's
 * statement shape under the same capture, from the journey the matrix names.
 */
export const AGENT_PATH_RECIPES: Partial<Record<CommandName, AgentRecipe>> = {
  'task.pickup': async (harness) => {
    await endLive(harness);
    return { prefix: 'agent', body: { reservationId: await reservation(harness) } };
  },
  'task.heartbeat': async (harness) => {
    const picked = await pickedUp(harness);
    return {
      prefix: 'agent',
      body: { leaseId: picked['leaseId'], fence: picked['fence'] },
      credential: String(picked['credential']),
    };
  },
  'task.handback': async (harness) => {
    const picked = await pickedUp(harness);
    return {
      prefix: 'agent',
      body: {
        leaseId: picked['leaseId'],
        fence: picked['fence'],
        outcome: 'completed',
        report: { wrote: 'a draft' },
      },
      credential: String(picked['credential']),
    };
  },
};

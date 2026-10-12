// SPDX-License-Identifier: AGPL-3.0-only
//
// A manager revokes an agent's delegation only within their own ceiling: they
// manage the collection and hold each pair the delegation carries. The
// ceiling is judged again once the revocation's locks are held, so a pair
// grant that lapses while the revocation waits on the delegation's row
// revokes nothing. The manager's `task:manage` stays live throughout, so
// only the ceiling, not the door, can refuse it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { holdRow, instantOf, waiterOf, waitPast } from '../support/lock-wait-race.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let harness: Harness;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('ceiling_in_revoke_wait');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/** A manager of the task holding `task:manage` there, and `task:write` for `seconds`. */
async function shortCeilingManager(seconds: number): Promise<{ manager: Member; ends: string }> {
  const { world } = harness;
  const manager = await enrol(world.db.app, world.alpha, `ceiling-${randomUUID().slice(0, 8)}`);
  const ends = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const [clock] = await tx.query<{ readonly at: Date }>(
      `select clock_timestamp() + make_interval(secs => $1) as at`,
      [seconds],
    );
    const scope = { kind: 'record' as const, id: harness.alphaTask.id };
    for (const [action, expiresAt] of [
      ['manage', null],
      ['write', clock?.at ?? null],
    ] as const) {
      // Sequential: one transaction.
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: manager.personId },
        scope,
        collection: 'task',
        action,
        expiresAt,
        parentGrantId: null,
        grantedByActorId: String(world.ada.actorId),
      });
      if (!issued.ok) throw new Error(`grant refused ${issued.refusal.code}`);
    }
    return clock?.at;
  });
  if (ends === undefined) throw new Error('no clock');
  return {
    manager,
    ends: await instantOf(world.db, 'select $1::timestamptz::text as at', [ends.toISOString()]),
  };
}

it('a manager whose pair grant lapses while the revocation waits on the delegation revokes nothing', async () => {
  const { world } = harness;
  const minted = await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await mintDelegation(tx, {
        agentActorId: String(world.agent.actorId),
        delegatePersonId: String(world.mia.personId),
        mintedByActorId: String(world.mia.actorId),
        purpose: `ceiling_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['write'],
        purposeScope: { kind: 'record', id: harness.alphaTask.id },
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
  );
  if (!minted.ok) throw new Error(`the delegation was refused ${minted.refusal.code}`);
  const delegationId = minted.value.delegation.id;
  const { manager, ends } = await shortCeilingManager(3);
  const held = await holdRow(
    world.db,
    'select id from public.delegations where id = $1 for update',
    [delegationId],
  );
  try {
    const revoking = executeCommand(world.db.app, world.alpha, manager.presented, 'api', {
      command: 'delegation.revoke',
      operationId: randomUUID(),
      delegationId,
    });
    revoking.catch(() => null);
    expect((await waiterOf(world.db, held)) < ends, 'the revocation began within the ceiling').toBe(
      true,
    );
    await waitPast(world.db, ends);
    await held.letGo();
    const answer = await revoking;
    const [row] = await world.db.admin.execute<{ readonly revoked: boolean }>(
      'select revoked_at is not null as revoked from public.delegations where id = $1',
      [delegationId],
    );
    expect({
      code: isCommandRefusal(answer) ? answer.code : 'applied',
      revoked: row?.revoked,
    }).toEqual({ code: 'SCOPE_NOT_GRANTED', revoked: false });
  } finally {
    await held.letGo();
  }
});

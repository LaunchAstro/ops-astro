// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 (CS-2.25): end a person's access in one act, and the session contract.
//
// `access.end {holderId}` is the tracked action `access ended (person: login,
// sessions, grants)` under `access:manage`, never an agent's. In one
// transaction it ends the membership, the person's acting identity, every live
// grant and delegation, and writes one access ending per login holding the two
// provider steps still owed: end every session (which revokes the refresh
// tokens) and deactivate the login. The local state is authoritative from the
// commit, so the person's next call is refused however the provider answers;
// the provider steps are tried when the act commits and retried until each is
// done, and a step done is never asked again.
//
// Sessions have no idle limit and an absolute limit of 12 hours from the first
// sign-in (the `amr` first-factor time, never `iat`), checked at the door.
//
// Ada is alpha's owner and holds every key; Mia holds the task keys; Noah holds
// nothing; Bea is bravo's, holding `access:manage` there. Each case enrols the
// person it ends. Every name below is made up.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  scripted,
  teammate,
  stateOf,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

// WORLD-IMPORTS c58-end-access-world.ts

useEndAccessWorld();

async function c58EndsAtOnceAGrantRacing(): Promise<void> {
  const { person } = await teammate('gus');
  const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
  const act = async (
    body: Readonly<Record<string, unknown>>,
    as = harness.world.ada.presented,
    businessId = harness.world.alpha,
  ) => {
    const result = await executeCommand(wide, businessId, as, 'api', {
      operationId: randomUUID(),
      ...body,
    } as Parameters<typeof executeCommand>[4]);
    return isCommandRefusal(result) ? result.code : 'ok';
  };
  try {
    const raced = await Promise.all([
      act({
        command: 'access.grant',
        holderId: person.personId,
        collection: 'task',
        action: 'comment',
      }),
      act({ command: 'access.end', holderId: person.personId }),
    ]);
    expect(raced[1]).toBe('ok');
    expect(['ok', 'NOT_FOUND']).toContain(raced[0]);
    expect(await stateOf(person)).toMatchObject({ liveGrants: 0, activeMemberships: 0 });

    const other = await enrol(
      harness.world.db.app,
      harness.world.bravo,
      `hal-${randomUUID().slice(0, 6)}`,
    );
    await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
      await grantTo(tx, other, 'manage', WHOLE_BUSINESS, false, 'access');
    });
    const bea = harness.world.bea.presented;
    const codes = await Promise.all([
      act({ command: 'access.end', holderId: other.personId }, bea, harness.world.bravo),
      act(
        { command: 'access.end', holderId: harness.world.bea.personId },
        other.presented,
        harness.world.bravo,
      ),
    ]);
    expect(codes.toSorted()).toEqual(['SCOPE_NOT_GRANTED', 'ok']);
  } finally {
    await wide.close();
  }
}

/** A live and an already expired delegation from one person, then their access ended. */
async function c58EndsOnlyTheLiveDelegations(): Promise<void> {
  const api = apiWith(scripted().provider);
  const { person } = await teammate('ivy');
  const give = async (purpose: string): Promise<string> =>
    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: harness.world.agent.actorId as string,
        delegatePersonId: person.personId,
        mintedByActorId: person.actorId,
        purpose,
        collections: ['task'],
        actions: ['write'],
        purposeScope: { kind: 'record', id: harness.alphaTask.id },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`delegation ${purpose} not minted`);
      return minted.value.delegation.id;
    });
  const live = await give('c58_still_live');
  const lapsed = await give('c58_lapsed');
  await harness.world.db.admin.execute(
    `update public.delegations
        set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      where id = $1`,
    [lapsed],
  );

  const ended = await end(api, person.personId);
  expect(outcome(ended)).toEqual({ status: 200, code: 'ok' });
  const detail = (ended.body['detail'] ?? {}) as Record<string, unknown>;
  expect(detail['delegationsRevoked']).toBe(1);
  const rows = await harness.world.db.admin.execute<{ id: string; revoked: boolean }>(
    `select id::text, revoked_at is not null as revoked from public.delegations
      where id = any($1::uuid[]) order by id`,
    [[live, lapsed]],
  );
  expect(Object.fromEntries(rows.map((row) => [row.id, row.revoked]))).toEqual({
    [live]: true,
    [lapsed]: false,
  });
}

describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it(
    'C58 one act: a delegation the person gave that had already expired is neither revoked again nor counted',
    c58EndsOnlyTheLiveDelegations,
  );

  it(
    'C58 ends at once: a grant racing an ending leaves nothing live, and two last managers ending each other leave one',
    c58EndsAtOnceAGrantRacing,
  );
});

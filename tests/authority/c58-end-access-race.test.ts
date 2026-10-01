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
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { harness, teammate, stateOf, useEndAccessWorld } from './c58-end-access-world.ts';

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
    expect(codes.toSorted()).toEqual(['ACCESS_LAST_MANAGER', 'ok']);
  } finally {
    await wide.close();
  }
}

describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it(
    'C58 ends at once: a grant racing an ending leaves nothing live, and two last managers ending each other leave one',
    c58EndsAtOnceAGrantRacing,
  );
});

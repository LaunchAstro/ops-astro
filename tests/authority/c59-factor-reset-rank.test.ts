// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (ORCH66-FACTORM2): no reset upward. `access.reset_factor` is refused
// FACTOR_RESET_REFUSED, in the one set of words, unless the caller holds every
// business-wide grant the member holds. A `settings:manage` holder who is not
// an owner cannot strip the owner's factor; an owner may reset another owner,
// a peer may reset an equal-grant peer, and the owner a member.
//
// Ada owns alpha and holds every key. Each case makes the people it needs.

import { describe, expect, it } from 'vitest';
import { heldPermissions } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { apiWith, harness, outcome, useEndAccessWorld } from './c58-end-access-world.ts';
import {
  factorFake,
  memberWithFactor,
  reset,
  resetState,
  type Enrolled,
} from './c59-factor-reset-world.ts';

useEndAccessWorld();

const OK = { status: 200, code: 'ok' };
const REFUSED = { status: 409, code: 'FACTOR_RESET_REFUSED' };

/** Each business-wide key Ada holds, granted to `member` too. */
async function asOwner(member: Member): Promise<void> {
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const ada = (await heldPermissions(tx)).filter(
      (held) => held.personId === harness.world.ada.personId && held.scope.kind === 'business',
    );
    expect(ada.length).toBeGreaterThan(2);
    for (const held of ada) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, member, held.action, WHOLE_BUSINESS, false, held.collection);
    }
  });
}

/** A member who also holds `settings:manage`, business-wide. */
async function settingsKeeper(name: string): Promise<Enrolled> {
  const enrolled = await memberWithFactor(name);
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await grantTo(tx, enrolled.person, 'manage', WHOLE_BUSINESS, false, 'settings');
  });
  return enrolled;
}

async function keeperCannotResetOwner(): Promise<void> {
  const { calls, provider } = factorFake();
  const owner = await memberWithFactor('ola');
  await asOwner(owner.person);
  const keeper = await settingsKeeper('kai');
  const before = await resetState(owner.person);
  const own = await reset(apiWith(provider), harness.world.ada.personId);

  const answer = await reset(apiWith(provider), owner.person.personId, keeper.token);
  expect(outcome(answer)).toEqual(REFUSED);
  expect(answer.body['fixes']).toEqual(own.body['fixes']);
  expect(await resetState(owner.person)).toEqual(before);
  expect(calls).toEqual([]);
}

async function ownerResetsOwner(): Promise<void> {
  const owner = await memberWithFactor('oma');
  await asOwner(owner.person);
  expect(outcome(await reset(apiWith(), owner.person.personId))).toEqual(OK);
  expect((await resetState(owner.person)).factors).toEqual(['removed']);
}

async function peerResetsPeer(): Promise<void> {
  const keeper = await settingsKeeper('pia');
  const peer = await settingsKeeper('pol');
  expect(outcome(await reset(apiWith(), peer.person.personId, keeper.token))).toEqual(OK);
  expect((await resetState(peer.person)).factors).toEqual(['removed']);
}

async function ownerResetsMember(): Promise<void> {
  const member = await memberWithFactor('mae');
  expect(outcome(await reset(apiWith(), member.person.personId))).toEqual(OK);
  expect((await resetState(member.person)).factors).toEqual(['removed']);
}

describe.skipIf(serverUrl === undefined)('C59 no reset upward', () => {
  it(
    'C59 rank: a settings:manage holder who is not an owner resetting the owner is refused FACTOR_RESET_REFUSED and nothing is written or sent',
    keeperCannotResetOwner,
  );
  it('C59 rank: an owner resets another owner', ownerResetsOwner);
  it('C59 rank: a peer resets a peer holding the same grants', peerResetsPeer);
  it('C59 rank: the owner resets a member', ownerResetsMember);
});

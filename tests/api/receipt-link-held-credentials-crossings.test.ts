// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the credentials a receipt link is checked against are the observing
// agent's own. They never take in another business's agent credentials, nor
// another person's agent credentials in the same business, in either
// direction. Assertions compare booleans, so a failure prints no credential.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  configuredCredentialKeys,
  issueAgentCredential,
  mintDelegation,
} from '../../packages/core-records/src/index.ts';
import { agentCredentials } from '../../packages/core-runtime/src/receipt-link.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('rcptcrossing');

/** An agent the person issued a login, and a delegation the person minted it. */
async function agentOf(business: string, person: Member) {
  const keys = configuredCredentialKeys();
  if (!keys.ok) throw new Error('no delegation credential keyring');
  return await r.fixture.db.app.withBusiness(business, async (tx) => {
    const login = await issueAgentCredential(tx, keys.keys, {
      personId: person.personId,
      actorId: person.actorId,
      purpose: `rcpt_${randomUUID().slice(0, 8)}`,
      scope: [{ collection: 'task', action: 'read' }],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const minted = await mintDelegation(tx, {
      agentActorId: login.agentActorId,
      delegatePersonId: person.personId,
      mintedByActorId: person.actorId,
      purpose: `rcpt_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read'],
      purposeScope: { kind: 'record', id: randomUUID() },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return {
      business,
      delegationId: minted.value.delegation.id,
      credentials: [login.credential, minted.value.credential],
    };
  });
}

/** A person in `business` who may read tasks there, so a delegation can draw on them. */
async function reader(business: string, name: string): Promise<Member> {
  const person = await enrol(r.fixture.db.app, business, name);
  await r.fixture.db.app.withBusiness(business, async (tx) => await grantTo(tx, person, 'read'));
  return person;
}

type Agent = Awaited<ReturnType<typeof agentOf>>;

/** What the observing agent is checked against, read in `business` (its own unless a crossing). */
const heldBy = async (observer: Agent, business = observer.business) =>
  (await r.fixture.db.app.withBusiness(
    business,
    async (tx) => await agentCredentials(tx, observer.delegationId),
  )) ?? [];

const holds = (held: readonly string[], agent: Agent): boolean[] =>
  agent.credentials.map((credential) => held.includes(credential));

it("an agent's checked credentials never cross business to business", async () => {
  const other = await insertBusiness(r.fixture.db.app, 'beta');
  await installSpine(r.fixture.db.app, other);
  const own = await agentOf(r.fixture.business, r.fixture.member);
  const foreign = await agentOf(other, await reader(other, 'beta-reader'));
  const [ownHeld, foreignHeld, crossed] = [
    await heldBy(own),
    await heldBy(foreign),
    await heldBy(foreign, r.fixture.business),
  ];
  expect({
    own: holds(ownHeld, own),
    ownHoldsForeign: holds(ownHeld, foreign),
    foreign: holds(foreignHeld, foreign),
    foreignHoldsOwn: holds(foreignHeld, own),
    crossedHolds: [...holds(crossed, foreign), ...holds(crossed, own)],
  }).toEqual({
    own: [true, true],
    ownHoldsForeign: [false, false],
    foreign: [true, true],
    foreignHoldsOwn: [false, false],
    crossedHolds: [false, false, false, false],
  });
});

it("an agent's checked credentials never cross person to person in one business", async () => {
  const own = await agentOf(r.fixture.business, r.fixture.member);
  const another = await agentOf(r.fixture.business, await reader(r.fixture.business, 'another'));
  const [ownHeld, anotherHeld] = [await heldBy(own), await heldBy(another)];
  expect({
    own: holds(ownHeld, own),
    ownHoldsAnother: holds(ownHeld, another),
    another: holds(anotherHeld, another),
    anotherHoldsOwn: holds(anotherHeld, own),
  }).toEqual({
    own: [true, true],
    ownHoldsAnother: [false, false],
    another: [true, true],
    anotherHoldsOwn: [false, false],
  });
});

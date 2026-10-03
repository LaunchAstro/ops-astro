// SPDX-License-Identifier: AGPL-3.0-only
//
// SEC3B F1, beside PLANFIX-3B-1 (`planfix-3b-1-planning-outcome.test.ts`): a
// planning reply held unknown whose owner's access has since ended (C58
// `access.end`, which deactivates their acting identity) is still released by
// the provider phase when its lookup proves nothing happened. The release
// event is the owner's, as their person actor, active or not, and the pass
// goes on to the next business: one ended owner never stops reconciliation for
// the deployment.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  callModelForPlanning,
  type ConversationCallRequest,
  type ModelCaller,
} from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { asPerson, codeOf, rows, type Schedules } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { CLOUD, LOCAL, noDatabase, s, world } from './broker-world.ts';
import { faultBroker, pass } from './aw-10-world.ts';
import { ask, local, ownerOf, p, rowsFor, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('sec3b1');

beforeAll(async () => {
  if (noDatabase) return;
  await openBilling(s);
  await openBilling(p.bravo);
}, 60_000);

/** A planning reply on `request` by `caller` in `on`, timed out and held unknown. */
async function heldReply(
  on: Schedules,
  caller: ModelCaller,
  request: ConversationCallRequest,
): Promise<void> {
  world.provider.mode('cut');
  world.provider.lookupMode('honest');
  const held = await callModelForPlanning(on.db.app, on.business, caller, request, {
    ...faultBroker(),
    routes: [LOCAL],
    audit: local(on).audit,
  });
  world.provider.mode('answer');
  expect(held).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
}

/** The ordinary offboarding: the decider, managing access, ends `personId`'s. */
async function endAccess(personId: string): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage', undefined, false, 'access');
  });
  const ended = await asPerson(s, {
    command: 'access.end',
    operationId: randomUUID(),
    holderId: personId,
  });
  expect(codeOf(ended)).toBe('applied');
}

it("SEC3B-1: an ended owner's planning reply is released in their name, and the pass goes on", async () => {
  // The owner, a person of alpha, and bravo's owner each have a reply held unknown.
  const owner = await enrol(s.db.app, s.business, 'sec3b1-owner');
  const asked = ask(s);
  const mine = { ...asked, conversation: { ...asked.conversation, ownerPersonId: owner.personId } };
  const theirs = ask(p.bravo);
  await heldReply(
    s,
    { actorId: owner.actorId, delegationId: null, attendedByPersonId: owner.personId },
    mine,
  );
  await heldReply(p.bravo, ownerOf(p.bravo), theirs);

  // Then the owner's access ends: their acting identity is no longer active.
  await endAccess(owner.personId);
  expect(await rows(s, `select active from public.actors where id = $1`, [owner.actorId])).toEqual([
    { active: false },
  ]);

  const passed = await pass([s, p.bravo], { ...faultBroker(), routes: [LOCAL, CLOUD] });

  expect(passed).toMatchObject({ ok: true });
  expect(await rowsFor(s, mine.conversation.id)).toMatchObject([
    { state: 'released', outcome: null },
  ]);
  expect(
    await rows(
      s,
      `select actor_id from public.audit_events
        where business_id = $1 and command = 'model.call_released'`,
      [s.business],
    ),
  ).toEqual([{ actor_id: owner.actorId }]);
  // The next business's held reply was reached by the same pass.
  expect(await rowsFor(p.bravo, theirs.conversation.id)).toMatchObject([
    { state: 'released', outcome: null },
  ]);
});

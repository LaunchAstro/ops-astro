// SPDX-License-Identifier: AGPL-3.0-only
//
// U14 on the command line: C58's `access.end` sent through the CLI client and
// straight to the API as the same caller (`cli-parity.ts`). Two teammates are
// ended, one through each surface: the same record bar the values minted per
// call, and each ended person's next call is refused alike on both. The
// refusals are the same word for word: without `access:manage`, another
// business by prefix and by id, a person already ended, one never enrolled, a
// malformed id and the agent route. No refusal ends anyone or changes a row.
//
// The world is C32's (`c32-clients-world.ts`): Ada is alpha's owner, Mia holds
// the task keys and nothing else, and Bea is bravo's, holding `access:manage`
// there. The provider steps are not asked here (the served app is built with
// no login provider), so the act is the local one, which is the one that
// refuses the next call (TR-SEC5-4).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tokenFor } from '../acceptance/cast.ts';
import { serverUrl } from '../acceptance/world.ts';
import { harness, useClientsWorld } from '../authority/c32-clients-world.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { both, oneEach, refusedAlike, refusedSame, sameRecord, type Route } from './cli-parity.ts';

useClientsWorld();

// Minted per call: the ids. The counts revoked are compared; one ending each is checked below.
const MINTED = new Set(['recordId', 'operationId', 'personId', 'endingIds']);

/** A teammate of `businessId` holding task read and write over the whole business. */
async function teammate(
  name: string,
  businessId: string = harness.world.alpha,
): Promise<{ readonly person: Member; readonly token: string }> {
  const person = await enrol(
    harness.world.db.app,
    businessId,
    `${name}-${randomUUID().slice(0, 6)}`,
  );
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    await grantTo(tx, person, 'read', WHOLE_BUSINESS);
    await grantTo(tx, person, 'write', WHOLE_BUSINESS);
  });
  return { person, token: await tokenFor(person.presented.subject) };
}

/** Everything `access.end` could touch in a business, to show a refusal changed nothing. */
const accessRows = async (businessId: string): Promise<readonly { readonly row: string }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(g)::text as row from public.grants g
         union all select to_jsonb(m)::text from public.memberships m
         union all select to_jsonb(a)::text from public.actors a
         union all select to_jsonb(d)::text from public.delegations d
         union all select to_jsonb(e)::text from public.access_endings e
         order by 1`,
      ),
  );

const end = (holderId: unknown) => ({ holderId });

type Teammate = Awaited<ReturnType<typeof teammate>>;

const endings = (answer: unknown): unknown[] =>
  (answer as { readonly detail: { readonly endingIds: unknown[] } }).detail.endingIds;

/** Two teammates ended, one through each surface; each one's next call refused alike. */
async function u14CliAccessEndApplies(stays: Teammate): Promise<Teammate> {
  const { world } = harness;
  const viaCli = await teammate('cli-leaver');
  const viaApi = await teammate('api-leaver');
  const bodies = { cli: end(viaCli.person.personId), api: end(viaApi.person.personId) };
  const ended = await oneEach(world.api, 'access.end', bodies, world.ada.token);
  sameRecord(ended, MINTED);
  expect(endings(ended.cli.body), 'one ending per login').toHaveLength(1);
  expect(endings(ended.api.body)).toHaveLength(1);

  // Each ended person's next call is refused, alike on both surfaces.
  const next = async (token: string) => await both(world.api, 'session.capabilities', {}, token);
  refusedAlike(await next(viaCli.token), 403, 'AUTH_NO_MEMBERSHIP');
  refusedAlike(await next(viaApi.token), 403, 'AUTH_NO_MEMBERSHIP');
  // The teammate who stays still reads.
  expect((await next(stays.token)).cli.status).toBe(200);
  return viaCli;
}

async function u14CliAccessEndRefuses(stays: Teammate, ended: Teammate): Promise<void> {
  const { world } = harness;
  const [ada, bea] = [world.ada.token, world.bea.token];
  const endBy = async (holderId: unknown, token: string, route?: Route) =>
    await both(world.api, 'access.end', end(holderId), token, route);
  const bravoPerson = await teammate('bravo-member', world.bravo);
  const rows = async () => ({
    alpha: await accessRows(world.alpha),
    bravo: await accessRows(world.bravo),
  });
  const before = await rows();
  // Without `access:manage`.
  refusedAlike(await endBy(stays.person.personId, world.mia.token), 403, 'SCOPE_NOT_GRANTED');
  // Another business: bravo's person by id through alpha, and alpha's by bravo's prefix.
  refusedSame(await endBy(bravoPerson.person.personId, ada));
  refusedSame(await endBy(stays.person.personId, bea, { businessKey: 'bravo' }));
  refusedSame(await endBy(stays.person.personId, ada, { businessKey: 'bravo' }));
  // Already ended, never enrolled, malformed.
  refusedSame(await endBy(ended.person.personId, ada));
  refusedSame(await endBy(randomUUID(), ada));
  refusedSame(await endBy('not-an-id', ada));
  // The agent route: never an agent's.
  refusedSame(await endBy(stays.person.personId, world.agent.token, { entry: 'agent' }));
  expect(await rows(), 'no refusal ended anyone or changed a row').toStrictEqual(before);
}

describe.skipIf(serverUrl === undefined)('U14 on the command line', () => {
  it('U14 CLI access.end: the command line ends access as the API does, and refuses alike', async () => {
    const stays = await teammate('stayer');
    const ended = await u14CliAccessEndApplies(stays);
    await u14CliAccessEndRefuses(stays, ended);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The Reviews page's counts (#2157): a listed review names its client and counts the live pins
// on its revisions not yet filed as a change request, and the change requests still waiting for
// a decision. Filing a pin moves it from one count to the other; deciding the request ends it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('revcount');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const listed = async () => {
  const answer = (await executeRead(w.world.db.app, w.world.business, w.ava.presented, {
    read: 'review.list',
  } as never)) as unknown as { readonly reviews: readonly Readonly<Record<string, unknown>>[] };
  return answer.reviews.find((review) => review['taskId'] === w.taskA);
};

describe.skipIf(serverUrl === undefined)('review.list counts', () => {
  it('counts open pins and open change requests, and names the client', async () => {
    const { clientPin } = await w.pins();
    expect(await listed()).toMatchObject({ partyId: w.partyA, openPins: 2, openChangeRequests: 0 });

    const filed = String(detailOf(await w.propose(w.ava, clientPin))['changeRequestId']);
    expect(await listed()).toMatchObject({ openPins: 1, openChangeRequests: 1 });

    await w.decide(w.ava, filed, 'refuse');
    expect(await listed()).toMatchObject({ openPins: 1, openChangeRequests: 0 });
  });
});

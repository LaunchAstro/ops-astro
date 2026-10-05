// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #439, SEC-439: a call's row records the route's key, reach and
// credential kind, not its credential. When two configured routes match all
// of those, either account could have carried the call, so a lookup through
// one cannot prove the call absent: the pass proves nothing and a person
// records the outcome.
import { expect, it as vitestIt } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { LOCAL, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { ask, local, ownerOf, rowsFor } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('reconcileambiguous');

it('reconciliation proves nothing when two configured routes match the route that carried the call', async () => {
  const on = await seedSchedules(s.db, 'reconcileambiguousroute', 1_000_000);
  const route = { ...LOCAL, key: 'twin_tuple_route' };
  // Same key, reach, provider and credential kind; another account.
  const other = { ...route, credentialRef: `${route.credentialRef}_other` };
  const base: Broker = { ...faultBroker(), routes: [route, other], audit: local(on).audit };
  const request = ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  world.provider.lookupMode('honest');

  await reconcileProviderCalls(on.db.app, on.business, base);

  expect(
    await rowsFor(on, request.conversation.id),
    'either account could have carried it; an absence on one proves nothing',
  ).toMatchObject([{ state: 'liability_unknown' }]);
});

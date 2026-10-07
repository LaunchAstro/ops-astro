// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #439, #943: a call's row records the provider and credential that
// carried it. Two configured routes may share its key, reach, provider and
// credential kind; the pass asks only through the one with its credential,
// wherever that one is listed, so another account's answer never decides it.
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

it('reconciliation asks only through the credential that carried the call when two routes share its key', async () => {
  const on = await seedSchedules(s.db, 'reconcileambiguousroute', 1_000_000);
  const route = { ...LOCAL, key: 'twin_tuple_route' };
  // Same key, reach, provider and credential kind; a credential custody does not hold.
  const other = { ...route, credentialRef: `${route.credentialRef}_other` };
  const carried: Broker = { ...faultBroker(), routes: [route], audit: local(on).audit };
  const request = await ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, carried),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  world.provider.lookupMode('honest');

  // The other route is listed first: a pass that took it would be refused by custody.
  await reconcileProviderCalls(on.db.app, on.business, { ...carried, routes: [other, route] });

  expect(
    await rowsFor(on, request.conversation.id),
    'the carrying credential proves the cut call never began',
  ).toMatchObject([{ state: 'released' }]);
});

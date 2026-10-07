// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #439: Sol's OW-016 criterion 1 proof, body as given (file and title named by
// behaviour; the other two OW-016 proofs belong to #601 and #440).
import { expect, it } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { LOCAL, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { ask, local, ownerOf, rowsFor } from './aw-04-planning-world.ts';

// Deliberately no skip: a Sol proof requires a reachable throwaway database.
useBrokerWorld('solow016lookup');

it('reconciliation uses the eligible route that carried the call when route keys collide', async () => {
  const on = await seedSchedules(s.db, 'solow016twinroute', 1_000_000);
  const route = { ...LOCAL, key: 'sol_twin_route' };
  // The cloud subscription route is configured for attended own work. It is
  // ineligible for planning's outside fields, so planning uses the local API key.
  const twin = { ...route, reach: 'cloud' as const, credentialKind: 'subscription' as const };
  const base: Broker = { ...faultBroker(), routes: [twin, route], audit: local(on).audit };
  const request = await ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  expect(await rowsFor(on, request.conversation.id)).toMatchObject([
    { route_reach: 'local', credential_kind: 'api_key' },
  ]);
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  await reconcileProviderCalls(on.db.app, on.business, base);
  expect(
    await rowsFor(on, request.conversation.id),
    'the eligible local API route has a usable absence proof; a same-key subscription must not replace it',
  ).toMatchObject([{ state: 'released' }]);
});

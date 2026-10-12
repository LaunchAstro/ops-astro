// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it as vitestIt } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { LOCAL, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { hold } from './aw-10-lookup-world.ts';
import { ask, local, ownerOf, rowsFor, setCap } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useBrokerWorld('x1372starve');

it('fifty calls waiting on a full route do not starve an absence proof on a free route', async () => {
  await setCap(s, 10_000_000);
  const olderRoute = { ...LOCAL, key: 'x1372-old-route', ceiling: 1 };
  const newerRoute = { ...LOCAL, key: 'x1372-new-route', ceiling: 1 };
  const base: Broker = { ...faultBroker(), audit: local(s).audit, routes: [olderRoute] };
  world.provider.mode('cut');
  for (let at = 0; at < 50; at += 1) {
    // eslint-disable-next-line no-await-in-loop
    const request = await ask(s);
    expect(
      // eslint-disable-next-line no-await-in-loop
      await callModelForPlanning(s.db.app, s.business, ownerOf(s), request, base),
    ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  }
  const newest = await ask(s);
  expect(
    await callModelForPlanning(s.db.app, s.business, ownerOf(s), newest, {
      ...base,
      routes: [newerRoute],
    }),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  await hold(s, base, 1);
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  const lookupBroker: Broker = { ...base, routes: [olderRoute, newerRoute] };
  await reconcileProviderCalls(s.db.app, s.business, lookupBroker);
  await reconcileProviderCalls(s.db.app, s.business, lookupBroker);
  const afterPasses = await rowsFor(s, newest.conversation.id);
  const freeRouteOnly: Broker = { ...base, routes: [newerRoute] };
  await reconcileProviderCalls(s.db.app, s.business, freeRouteOnly);
  await reconcileProviderCalls(s.db.app, s.business, freeRouteOnly);
  expect(
    await rowsFor(s, newest.conversation.id),
    'the provider can prove absence for the newer call',
  ).toMatchObject([{ state: 'released' }]);
  expect(afterPasses).toMatchObject([{ state: 'released' }]);
}, 180_000);

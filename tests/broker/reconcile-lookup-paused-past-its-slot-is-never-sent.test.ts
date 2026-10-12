// SPDX-License-Identifier: AGPL-3.0-only
//
// A reconciliation lookup takes its slot on the asked call (`lookup_until`),
// which the route's ceiling counts until it ends, the operation's timeout plus
// a minute on. A lookup that reached custody only after that would go out
// beside a later pass's, or a model call's, that took its place. Custody is
// told when the slot ends, so such a lookup is never sent, proves nothing, and
// the call stays held unknown for the next pass.

import { expect, it as vitestIt } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { custodyAhead } from './custody-clock-ahead.ts';
import { LOCAL, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { ask, local, ownerOf, rowsFor } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('lookuppastslot');

it('a lookup that reaches custody after its slot has ended reaches no provider and leaves the call held', async () => {
  const on = await seedSchedules(s.db, 'lookuppastslotroute', 1_000_000);
  const carried: Broker = { ...faultBroker(), routes: [LOCAL], audit: local(on).audit };
  const request = await ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, carried),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  const before = world.provider.seen.length;

  const [proof] = await custodyAhead(
    REPLAY_COMPOSE.timeoutMs + 60_000,
    async () => await reconcileProviderCalls(on.db.app, on.business, carried),
  );

  expect({
    proved: proof?.proved,
    rows: await rowsFor(on, request.conversation.id),
    asked: world.provider.seen.length - before,
  }).toMatchObject({ proved: false, rows: [{ state: 'liability_unknown' }], asked: 0 });
});

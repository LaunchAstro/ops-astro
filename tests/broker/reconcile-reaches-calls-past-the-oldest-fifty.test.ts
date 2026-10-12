// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #440: one pass asks about at most 50 calls in a business. A call
// whose lookup proved nothing goes to the back of the line, so fifty old
// calls that never prove absence cannot keep a newer call from being asked,
// and released, on a later pass.
import { expect, it as vitestIt } from 'vitest';
import { operationOf } from '../../packages/core-connectors/src/replay-lookup.ts';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { LOCAL, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { ask, local, ownerOf, rowsFor, setCap } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('reconcilerotates');

it('a call past the oldest fifty unproved calls is asked and released on a later pass', async () => {
  const on = await seedSchedules(s.db, 'reconcilerotatesmany', 1_000_000);
  const base: Broker = { ...faultBroker(), routes: [LOCAL], audit: local(on).audit };
  // Planning room for every held call.
  await setCap(on, 10_000_000);
  world.provider.mode('cut');
  const conversations: string[] = [];
  for (let at = 0; at < 51; at += 1) {
    // eslint-disable-next-line no-await-in-loop -- each call held unknown after the one before
    const request = await ask(on);
    expect(
      // eslint-disable-next-line no-await-in-loop -- one call at a time, oldest first
      await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base),
    ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
    conversations.push(request.conversation.id);
  }
  const newest = String((await rowsFor(on, conversations.at(-1) ?? ''))[0]?.['id']);
  world.provider.mode('answer');
  world.provider.lookupMode('honest');

  // The provider answers the declared absence for the newest call only; the
  // oldest fifty answer that work began, which proves nothing.
  const asked: string[] = [];
  const began: Broker = {
    ...base,
    custody: {
      ...base.custody,
      dispatch: async (credentialRef, request) => {
        const outcome = await base.custody.dispatch(credentialRef, request);
        const id = operationOf(request.body);
        asked.push(id ?? '');
        if (id === newest || outcome.kind !== 'answered' || !outcome.outbound.ok) return outcome;
        return { ...outcome, outbound: { ...outcome.outbound, body: '{"code":"began"}' } };
      },
    },
  };
  await reconcileProviderCalls(on.db.app, on.business, began);
  await reconcileProviderCalls(on.db.app, on.business, began);

  expect(asked, 'the second pass asks about the call the first pass left out').toContain(newest);
  expect(await rowsFor(on, conversations.at(-1) ?? '')).toMatchObject([{ state: 'released' }]);
  expect(await rowsFor(on, conversations[0] ?? '')).toMatchObject([{ state: 'liability_unknown' }]);
}, 180_000);

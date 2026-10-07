// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #439, #943: the pass releases a held call only through the
// provider, credential and account its row recorded at the send. A row that
// names none of them (written before 20261005100149), names no account, or
// whose operation now goes to another provider releases nothing, even where
// the same credential would answer that the call never began.
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

useBrokerWorld('reconcilecarrier');

/** A planning call cut before it began, held unknown, and the stand-in answering honestly after. */
const cutCall = async (label: string) => {
  const on = await seedSchedules(s.db, label, 1_000_000);
  const base: Broker = { ...faultBroker(), routes: [LOCAL], audit: local(on).audit };
  const request = await ask(on);
  world.provider.mode('cut');
  expect(
    await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base),
  ).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  return { on, base, conversation: request.conversation.id, operation: request.operation };
};

it('a held call is released through the account recorded at its send', async () => {
  const { on, base, conversation } = await cutCall('reconcilecarrierrecorded');
  expect(await rowsFor(on, conversation)).toMatchObject([
    { provider: LOCAL.provider, credential_ref: LOCAL.credentialRef, account: expect.any(String) },
  ]);
  await reconcileProviderCalls(on.db.app, on.business, base);
  expect(await rowsFor(on, conversation)).toMatchObject([{ state: 'released' }]);
});

it.each([
  [
    'no provider or credential, as written before the carrier was recorded',
    'provider = null, credential_ref = null',
  ],
  ['no account', 'account = null'],
])('a held call whose row names %s releases nothing', async (_, cleared) => {
  const { on, base, conversation } = await cutCall(`reconcilecarrier${cleared.length}`);
  await on.db.admin.execute(`update public.model_calls set ${cleared} where conversation_id = $1`, [
    conversation,
  ]);
  await reconcileProviderCalls(on.db.app, on.business, base);
  expect(await rowsFor(on, conversation)).toMatchObject([{ state: 'liability_unknown' }]);
});

it('a held call whose operation now goes to another provider on the same destination releases nothing', async () => {
  const { on, base, conversation, operation } = await cutCall('reconcilecarriermoved');
  const declared = base.operations.get(operation);
  const adapter = base.providers.get(LOCAL.provider);
  if (declared === undefined || adapter === undefined) throw new Error('no operation or adapter');
  // The same destination and credential would answer honestly that it never began.
  await reconcileProviderCalls(on.db.app, on.business, {
    ...base,
    operations: new Map([...base.operations, [operation, { ...declared, provider: 'moved' }]]),
    providers: new Map([...base.providers, ['moved', adapter]]),
    routes: [LOCAL, { ...LOCAL, provider: 'moved' }],
  });
  expect(await rowsFor(on, conversation)).toMatchObject([{ state: 'liability_unknown' }]);
});

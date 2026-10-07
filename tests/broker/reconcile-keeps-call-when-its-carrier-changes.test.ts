// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import {
  callModelForPlanning,
  reconcileProviderCalls,
  startCustody,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import {
  REPLAY_LOOKUP_PATH,
  startReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { LOCAL, s, useBrokerWorld, world } from './broker-world.ts';
import { faultBroker } from './aw-10-world.ts';
import { allowance, ask, local, ownerOf, rowsFor } from './aw-04-planning-world.ts';

useBrokerWorld('sol944credential');

it.each(['route reference', 'credential account'])(
  'changing the %s cannot release a processed call or restore its budget',
  async (change) => {
    const on = await seedSchedules(
      s.db,
      `sol944credentialchange${change.replaceAll(' ', '')}`,
      1_000_000,
    );
    const processed = new Set<string>();
    const lookups: string[] = [];
    // An account-scoped provider: it finishes work, loses the reply, and answers
    // lookups only from the account named by the credential custody presented.
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const part of request) body += String(part);
        const shape: unknown = JSON.parse(body);
        if (typeof shape !== 'object' || shape === null || !('operation_id' in shape)) {
          response.writeHead(400).end();
          return;
        }
        const account = request.headers.authorization ?? '';
        const operationId = String(shape.operation_id);
        const key = `${account}:${operationId}`;
        if (request.url !== REPLAY_LOOKUP_PATH) {
          processed.add(key);
          response.socket?.destroy();
          return;
        }
        lookups.push(account);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            code: processed.has(key) ? 'completed' : 'rejected_before_processing',
          }),
        );
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no provider port');
    const credentialsFile = world.writeCredentials([
      {
        ref: 'sol944_account_a',
        kind: 'api_key',
        account: 'account-a',
        destination: 'replay',
        header: 'authorization',
        value: 'sol944-account-a-key',
      },
      {
        ref: 'sol944_account_b',
        kind: 'api_key',
        account: 'account-b',
        destination: 'replay',
        header: 'authorization',
        value: 'sol944-account-b-key',
      },
    ]);
    const custody = await startCustody({
      credentialsFile,
      destinations: [{ key: 'replay', origin: `http://127.0.0.1:${address.port}` }],
    });
    let replacementCustody: Awaited<ReturnType<typeof startCustody>> | undefined;
    try {
      const route = { ...LOCAL, key: 'carrying_route', credentialRef: 'sol944_account_a' };
      const base: Broker = { ...faultBroker(), custody, routes: [route], audit: local(on).audit };
      const request = await ask(on);
      const result = await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base);
      expect(result).toMatchObject({ code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
      if (result.callId === null) throw new Error('no held call');
      expect(processed.has(`Bearer sol944-account-a-key:${result.callId}`)).toBe(true);
      expect(await allowance(on, on.decider.personId, request.conversation.id)).toMatchObject({
        leftMinor: 4_500,
        conversation: { heldMinor: 500 },
      });
      // Positive control: account A's lookup sees the processed call and keeps it held.
      await reconcileProviderCalls(on.db.app, on.business, base);
      expect(await rowsFor(on, request.conversation.id)).toMatchObject([
        { state: 'liability_unknown' },
      ]);
      expect(lookups).toEqual(['Bearer sol944-account-a-key']);

      // The account changes either through the route reference or through the
      // credential file on restart. Neither changes what the call row records.
      if (change === 'credential account') {
        replacementCustody = await startCustody({
          credentialsFile: world.writeCredentials([
            {
              ref: 'sol944_account_a',
              kind: 'api_key',
              account: 'account-b',
              destination: 'replay',
              header: 'authorization',
              value: 'sol944-account-b-key',
            },
          ]),
          destinations: [{ key: 'replay', origin: `http://127.0.0.1:${address.port}` }],
        });
      }
      await reconcileProviderCalls(on.db.app, on.business, {
        ...base,
        custody: replacementCustody ?? custody,
        routes: [
          change === 'route reference' ? { ...route, credentialRef: 'sol944_account_b' } : route,
        ],
      });
      expect
        .soft(await rowsFor(on, request.conversation.id))
        .toMatchObject([{ state: 'liability_unknown' }]);
      expect.soft(await allowance(on, on.decider.personId, request.conversation.id)).toMatchObject({
        leftMinor: 4_500,
        conversation: { heldMinor: 500 },
      });
    } finally {
      await replacementCustody?.stop();
      await custody.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('changing an operation provider cannot release an already processed call', async () => {
  const on = await seedSchedules(s.db, 'sol944providerchange', 1_000_000);
  const other = await startReplayProvider();
  const credentialsFile = world.writeCredentials([
    {
      ref: 'replay_key',
      kind: 'api_key',
      account: 'original-provider-account',
      destination: 'replay',
      header: 'authorization',
      value: world.canary,
    },
    {
      ref: 'sol944_provider_b',
      kind: 'api_key',
      account: 'new-provider-account',
      destination: 'sol944_provider_b',
      header: 'authorization',
      value: 'sol944-new-provider-key',
    },
  ]);
  const custody = await startCustody({
    credentialsFile,
    destinations: [
      { key: 'replay', origin: world.provider.origin },
      { key: 'sol944_provider_b', origin: other.origin },
    ],
  });
  try {
    const route = { ...LOCAL, key: 'sol944_provider_route' };
    const twin = { ...route, provider: 'sol944_provider_b', credentialRef: 'sol944_provider_b' };
    const base: Broker = {
      ...faultBroker(),
      custody,
      routes: [route, twin],
      audit: local(on).audit,
    };
    const request = await ask(on);
    world.provider.mode('slow');
    const result = await callModelForPlanning(on.db.app, on.business, ownerOf(on), request, base);
    expect(result).toMatchObject({ code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
    if (result.callId === null) throw new Error('no held call');
    expect(world.provider.processed.has(result.callId)).toBe(true);
    world.provider.lookupMode('honest');
    await reconcileProviderCalls(on.db.app, on.business, base);
    expect(await rowsFor(on, request.conversation.id)).toMatchObject([
      { state: 'liability_unknown' },
    ]);

    const operation = base.operations.get(request.operation);
    const adapter = base.providers.get('replay');
    if (operation === undefined || adapter === undefined)
      throw new Error('no operation or adapter');
    // A deployment moves this stable operation key to a new provider. Both
    // routes remain configured, with the original first, but the row carries
    // no provider or credential identity to associate with the held call.
    await reconcileProviderCalls(on.db.app, on.business, {
      ...base,
      operations: new Map([
        [
          operation.key,
          { ...operation, provider: 'sol944_provider_b', destination: 'sol944_provider_b' },
        ],
      ]),
      providers: new Map([...base.providers, ['sol944_provider_b', adapter]]),
    });
    expect
      .soft(await rowsFor(on, request.conversation.id))
      .toMatchObject([{ state: 'liability_unknown' }]);
    expect.soft(await allowance(on, on.decider.personId, request.conversation.id)).toMatchObject({
      leftMinor: 4_500,
      conversation: { heldMinor: 500 },
    });
  } finally {
    await custody.stop();
    await other.close();
  }
});

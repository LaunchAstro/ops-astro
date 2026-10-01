// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 (CS-2.15): the client record, and grants given and revoked on Settings ▸
// Access. A client is a row of its business (`client.create`, the tracked
// action `record created (client)` under `record:write`); a grant names a
// person of the business, a key from the catalogue and either the whole
// business or one client (`access.grant` and `access.revoke`, the tracked
// action `grant changed` under `access:manage`, never an agent's). The
// person's preview on `access.read` is the grant check's own walk, so a
// teammate given one client sees that client and nothing else, and
// `client.list` answers the clients a caller's live grants reach, filtered
// inside the query.
//
// Ada is alpha's owner and holds every key the surface declares; Mia holds the
// task keys at business scope and nothing else; Noah holds nothing; Tia is a
// teammate enrolled here with no grant. Bea is bravo's, holding `access:manage`
// and `record:write` there. A client person of alpha stands on a share, and
// the agent acts under a live delegation from Ada. Every name below is made up.

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  CANARY,
  detailOf,
  outcome,
  harness,
  tia,
  tiaToken,
  clientToken,
  credential,
  as,
  createClient,
  give,
  revoke,
  listClients,
  rowsOf,
  useClientsWorld,
} from './c32-clients-world.ts';

useClientsWorld();

async function c32IsolationAnotherBusinessAnotherClientAnd(): Promise<void> {
  const alphaOne = await createClient(`Alpha One ${randomUUID().slice(0, 6)}`);
  const alphaTwo = await createClient(`Alpha Two ${randomUUID().slice(0, 6)}`);
  const bravoName = `Bravo Only ${randomUUID().slice(0, 6)}`;
  const bravoClient = await createClient(bravoName, harness.world.bea.token, 'bravo');
  const alphaBefore = await rowsOf(harness.world.alpha);
  const bravoBefore = await rowsOf(harness.world.bravo);

  // Another business. Bea on bravo cannot name alpha's person, client or
  // grant, and each is the same NOT_FOUND as a made-up one.
  const tiaGrant = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: alphaOne,
  });
  const tiaGrantId = detailOf(tiaGrant)['grantId'];
  const alphaAfterGrant = await rowsOf(harness.world.alpha);
  const beaAcross = [
    await give(
      { holderId: tia.personId, collection: 'task', action: 'read' },
      harness.world.bea.token,
      'bravo',
    ),
    await give(
      {
        holderId: harness.world.bea.personId,
        collection: 'task',
        action: 'read',
        clientId: alphaOne,
      },
      harness.world.bea.token,
      'bravo',
    ),
    await revoke(tiaGrantId, harness.world.bea.token, 'bravo'),
  ];
  expect(beaAcross.map((answer) => outcome(answer))).toEqual([
    { status: 404, code: 'NOT_FOUND' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 404, code: 'NOT_FOUND' },
  ]);
  const beaList = await listClients(harness.world.bea.token, 'bravo');
  expect(beaList.body['clients']).toEqual([{ clientId: bravoClient, name: bravoName }]);
  // Bea on alpha's prefix is no member of alpha.
  const onAlpha = await give(
    { holderId: tia.personId, collection: 'task', action: 'read' },
    harness.world.bea.token,
  );
  expect(outcome(onAlpha)).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
  // Alpha cannot give access to bravo's client.
  const bravoFromAlpha = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: bravoClient,
  });
  expect(outcome(bravoFromAlpha)).toEqual({ status: 404, code: 'NOT_FOUND' });
  const alphaAccess = await as('/access/read', {});
  expect(JSON.stringify(alphaAccess.body)).not.toContain(bravoClient);
  expect(JSON.stringify(alphaAccess.body)).not.toContain(bravoName);

  // Another client in the same business: Tia holds alphaOne and is never
  // shown, told the count of, or given alphaTwo.
  const tiaList = await listClients(tiaToken);
  expect(tiaList.body['clients']).toEqual([
    { clientId: alphaOne, name: expect.stringContaining('Alpha One') },
  ]);
  expect(JSON.stringify(tiaList.body)).not.toContain(alphaTwo);
  // A client person stands on a share of one task, which reaches no client.
  const clientList = await listClients(clientToken);
  expect(outcome(clientList)).toEqual({ status: 200, code: 'ok' });
  expect(clientList.body['clients']).toEqual([]);

  // Another person under a live delegation: the agent acting for Ada, who
  // holds access:manage and record:write, is refused all four.
  for (const [path, body] of [
    ['/access/grant', { holderId: tia.personId, collection: 'task', action: 'read' }],
    ['/access/revoke', { grantId: tiaGrantId }],
    ['/client/create', { name: 'Agent Made' }],
    ['/client/list', {}],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    const agent = await call(
      harness.world.api,
      agentPath('alpha', path),
      path === '/client/list' ? body : { operationId: randomUUID(), ...body },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(outcome(agent), path).toEqual({
      status: 403,
      code: 'DELEGATION_EXCLUDES_OPERATION',
    });
  }

  expect(await rowsOf(harness.world.alpha)).toEqual(alphaAfterGrant);
  expect(await rowsOf(harness.world.bravo)).toEqual(bravoBefore);
  expect(alphaAfterGrant.length).toBe(alphaBefore.length + 1);
  expect((await revoke(tiaGrantId)).code).toBe('ok');
}

async function c32CanaryAClientNameCarryingA(): Promise<void> {
  const logged: string[] = [];
  const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(capture),
  );
  let clientId = '';
  try {
    clientId = await createClient(`Clinic ${CANARY}`);
    const given = await give({
      holderId: tia.personId,
      collection: 'task',
      action: 'read',
      clientId,
    });
    const answers = [
      await as('/client/create', { operationId: randomUUID(), name: `Clinic ${CANARY}` }),
      await as(
        '/client/create',
        { operationId: randomUUID(), name: `Clinic ${CANARY}` },
        harness.world.noah.token,
      ),
      await give({ holderId: randomUUID(), collection: 'task', action: 'read', clientId }),
      await give({ holderId: tia.personId, collection: CANARY, action: 'read', clientId }),
      await revoke(randomUUID()),
      await listClients(harness.world.noah.token),
    ];
    for (const answer of answers) {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    // A client person on a share reaches no client, so is shown none.
    expect((await listClients(clientToken)).body['clients']).toEqual([]);
    expect(
      JSON.stringify((await listClients(harness.world.bea.token, 'bravo')).body),
    ).not.toContain(CANARY);
    expect((await revoke(detailOf(given)['grantId'])).code).toBe('ok');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(CANARY);

  const stored = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
        where command in ('client.create', 'client.list', 'access.grant', 'access.revoke')
       union all
       select to_jsonb(o)::text from public.operations o
        where command in ('client.create', 'access.grant', 'access.revoke')`,
      ),
  );
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
}

describe.skipIf(serverUrl === undefined)(
  'C32 the client record and grants on Settings ▸ Access',
  () => {
    it(
      "C32 isolation: another business, another client and a delegated agent never read, list, count or change another's clients or grants",
      c32IsolationAnotherBusinessAnotherClientAnd,
    );

    it(
      'C32 canary: a client name carrying a planted secret reaches no log, audit row, operation row or refusal, and another business never sees it',
      c32CanaryAClientNameCarryingA,
    );
  },
);

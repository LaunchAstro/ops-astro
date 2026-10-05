// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 (CS-7.40): who may change a client's privacy settings, and what never
// crosses. `client.set_privacy` is `privacy:manage` on the named client, never
// an agent's: a holder over one client changes that client and is refused
// another of the same business, and another business's client answers as a
// made-up one. A planted secret in a client's written request reaches no log,
// refusal, response, operation row or audit payload. The world is
// `c60-client-privacy-world.ts`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkClientEditRun } from '../../packages/core-records/src/clients/privacy.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  ALL_OFF,
  appliedDetail,
  as,
  assess,
  clientRow,
  clientToken,
  createClient,
  credential,
  give,
  harness,
  member,
  newClient,
  outcome,
  privacyOnAccess,
  request,
  requestsOf,
  setPrivacy,
  tia,
  tiaToken,
  useClientsWorld,
} from './c60-client-privacy-world.ts';
import { consoleLine } from '../support/console-text.ts';

useClientsWorld();

const CANARY = 'CANARY-c60-client-request-4be1f2';
const MADE_UP = '00000000-0000-4000-8000-0000000000c6';
const SWITCH_ON = { modelEgress: true, providers: ['replay'] } as const;

/** Tia given `privacy:manage` over one client of alpha's, by Ada on Settings ▸ Access. */
const tiaManages = async (clientId: string): Promise<void> => {
  const given = await give({
    holderId: tia.personId,
    collection: 'privacy',
    action: 'manage',
    clientId,
  });
  appliedDetail(given, 'privacy:manage over one client');
};

const SET_PRIVACY_REFUSED = { status: 403, code: 'SCOPE_NOT_GRANTED' };

async function c60RefusalPrivacyManage(): Promise<void> {
  await assess('replay');
  const clientId = await newClient('Refusal Clinic');
  const sent = { ...SWITCH_ON, noAgentEdits: true, ...request() };
  const people = [harness.world.mia.token, harness.world.noah.token, tiaToken, clientToken];
  for (const token of people) {
    // oxlint-disable-next-line no-await-in-loop
    expect(outcome(await setPrivacy(clientId, sent, token))).toEqual(SET_PRIVACY_REFUSED);
  }
  // The agent acting for Ada, who holds privacy:manage, is refused it.
  const agent = await call(
    harness.world.api,
    agentPath('alpha', '/client/set_privacy'),
    { operationId: randomUUID(), clientId, ...ALL_OFF, ...sent },
    { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
  );
  expect(outcome(agent)).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
  expect(await clientRow(clientId)).toEqual(ALL_OFF);
  expect(await requestsOf(clientId)).toEqual([]);

  // Given the key over this client, the teammate changes it.
  await tiaManages(clientId);
  appliedDetail(await setPrivacy(clientId, sent, tiaToken), 'Tia over her client');
  expect(await clientRow(clientId)).toEqual({ ...ALL_OFF, ...SWITCH_ON, noAgentEdits: true });
}

interface Isolated {
  readonly alphaOne: string;
  readonly alphaTwo: string;
  readonly bravoClient: string;
}

/** Two clients of alpha's, Tia holding the first alone, and one of bravo's, Bea holding bravo. */
async function isolatedWorld(): Promise<Isolated> {
  await assess('replay');
  const alphaOne = await newClient('Alpha One');
  const alphaTwo = await newClient('Alpha Two');
  const bravoName = `Bravo Only ${randomUUID().slice(0, 6)}`;
  const bravoClient = await createClient(bravoName, harness.world.bea.token, 'bravo');
  await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    await grantTo(tx, member(harness.world.bea), 'manage', WHOLE_BUSINESS, false, 'privacy');
  });
  await assess('replay', true, 'bravo');
  await tiaManages(alphaOne);
  return { alphaOne, alphaTwo, bravoClient };
}

/** Another business's client answers as a made-up one, to each caller; another client is refused. */
async function crossingsRefused({ alphaOne, alphaTwo, bravoClient }: Isolated): Promise<void> {
  const sent = { ...SWITCH_ON, ...request() };
  expect(outcome(await setPrivacy(alphaTwo, sent, tiaToken))).toEqual(SET_PRIVACY_REFUSED);
  const pair = async (foreign: string, token?: string, key?: string) => ({
    foreign: await setPrivacy(foreign, sent, token, key),
    madeUp: await setPrivacy(MADE_UP, sent, token, key),
  });
  const tiaAcross = await pair(bravoClient, tiaToken);
  const adaAcross = await pair(bravoClient);
  const beaAcross = await pair(alphaOne, harness.world.bea.token, 'bravo');
  for (const { foreign, madeUp } of [tiaAcross, adaAcross, beaAcross]) {
    expect(outcome(foreign)).toEqual(outcome(madeUp));
    expect(foreign.text).toBe(madeUp.text);
  }
  expect(outcome(adaAcross.foreign)).toEqual({ status: 404, code: 'NOT_FOUND' });
  expect(outcome(beaAcross.foreign)).toEqual({ status: 404, code: 'NOT_FOUND' });
  // Bea on alpha's prefix is no member of alpha.
  expect(outcome(await setPrivacy(alphaOne, sent, harness.world.bea.token))).toEqual({
    status: 403,
    code: 'AUTH_NO_MEMBERSHIP',
  });
  for (const [clientId, business] of [
    [alphaTwo, harness.world.alpha],
    [bravoClient, harness.world.bravo],
    [alphaOne, harness.world.alpha],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await clientRow(clientId, business), clientId).toEqual(ALL_OFF);
    // oxlint-disable-next-line no-await-in-loop
    expect(await requestsOf(clientId, business), clientId).toEqual([]);
  }
}

async function c60Isolation(): Promise<void> {
  const world = await isolatedWorld();
  const { alphaOne, bravoClient } = world;
  await crossingsRefused(world);

  // Tia's own client changes; neither business reads the other's.
  appliedDetail(await setPrivacy(alphaOne, { ...SWITCH_ON, ...request() }, tiaToken), 'Tia');
  expect(await privacyOnAccess(bravoClient)).toBeUndefined();
  expect(await privacyOnAccess(alphaOne, harness.world.bea.token, 'bravo')).toBeUndefined();
  const bravoAccess = await as('/access/read', {}, harness.world.bea.token, 'bravo');
  expect(bravoAccess.text).not.toContain(alphaOne);
  expect(await privacyOnAccess(bravoClient, harness.world.bea.token, 'bravo')).toEqual({
    clientId: bravoClient,
    ...ALL_OFF,
  });
  // The edit run's check, from bravo's tenancy, finds no alpha client.
  const fromBravo = await harness.world.db.app.withBusiness(
    harness.world.bravo,
    async (tx) => await checkClientEditRun(tx, alphaOne, 'replay'),
  );
  expect(fromBravo).toEqual({ ok: false, code: 'CLIENT_MODEL_USE_OFF' });
}

/** Each answer a planted request meets, with the console captured throughout. */
async function plantedAnswers(clientId: string, logged: string[]): Promise<readonly Answer[]> {
  const planted = request({
    requestedBy: `Dana ${CANARY}`,
    requestLink: `https://files.example.test/${CANARY}.pdf`,
  });
  const capture = (...parts: unknown[]) => void logged.push(consoleLine(...parts));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(capture),
  );
  try {
    return [
      await setPrivacy(clientId, { modelEgress: true, providers: ['claude'], ...planted }),
      await setPrivacy(clientId, { modelEgress: true, providers: [CANARY], ...planted }),
      await setPrivacy(clientId, { ...SWITCH_ON, ...planted, requestedOn: CANARY }),
      await setPrivacy(clientId, { ...SWITCH_ON, ...planted, requestLink: CANARY.repeat(80) }),
      await setPrivacy(MADE_UP, { ...SWITCH_ON, ...planted }),
      await setPrivacy(clientId, { ...SWITCH_ON, ...planted }, harness.world.noah.token),
      await setPrivacy(clientId, { ...SWITCH_ON, ...planted }),
      await as('/access/read', {}),
    ];
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

async function c60Canary(): Promise<void> {
  await assess('replay');
  await assess('claude');
  const clientId = await newClient('Canary Clinic');
  const logged: string[] = [];
  const answers = await plantedAnswers(clientId, logged);
  expect(answers.map((answer) => answer.status)).toEqual([501, 422, 422, 422, 404, 403, 200, 200]);
  for (const answer of answers) expect(answer.text).not.toContain(CANARY);
  expect(logged.join('\n')).not.toContain(CANARY);

  const stored = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'client.set_privacy'
         union all
         select to_jsonb(o)::text from public.operations o where command = 'client.set_privacy'`,
      ),
  );
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
  const kept = await requestsOf(clientId);
  expect(kept.map((each) => each.outcome)).toEqual(['LOCAL_MODEL_REQUIRED', 'applied']);
  expect(kept.map((each) => each.requestedBy)).toEqual([`Dana ${CANARY}`, `Dana ${CANARY}`]);
}

describe.skipIf(serverUrl === undefined)('C60 client privacy refusals', () => {
  it(
    'C60 refusal privacy:manage: a task holder, a member with nothing, a teammate without the key, a client and a delegated agent are refused, with nothing written',
    c60RefusalPrivacyManage,
  );
  it(
    'C60 isolation: two businesses and two clients, one grant each: another business client answers as a made-up one, and another client of the same business is refused',
    c60Isolation,
  );
  it(
    'C60 canary: a planted secret in a written request reaches no log, refusal, response, operation row or audit payload, and is kept on the request record alone',
    c60Canary,
  );
});

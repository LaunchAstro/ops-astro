// SPDX-License-Identifier: AGPL-3.0-only
//
// U14 on the command line: C32's `access.read`, `access.grant` and
// `access.revoke`, and C34's `operations.read`, each sent through the CLI
// client and straight to the API as the same caller with the same body
// (`cli-parity.ts`). Each pair answers alike: the same record bar the values
// minted per call, and the same refusal word for word, per key, business to
// business by prefix and by id, client to client across businesses, an
// unknown or already revoked id, a malformed field and the agent route. No
// refusal writes or changes a row. `access.end` has a file of its own
// (`u14-access-end-cli.test.ts`), since it ends people.
//
// The world is C32's (`c32-clients-world.ts`): Ada is alpha's owner, Mia holds
// the task keys and nothing else, Tia is a teammate with no grant, and Bea is
// bravo's, holding `access:manage` and `record:write` there.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  clientToken,
  createClient,
  detailOf,
  give,
  harness,
  rowsOf,
  tia,
  useClientsWorld,
} from '../authority/c32-clients-world.ts';
import {
  alike,
  both as bothOn,
  oneEach,
  refusedAlike,
  refusedSame,
  sameRecord,
  type Route,
} from './cli-parity.ts';

useClientsWorld();

const both = async (
  verb: string,
  body: Readonly<Record<string, unknown>>,
  token: string,
  route?: Route,
) => await bothOn(harness.world.api, verb, body, token, route);

// Minted per call: ids, and the moment each record was stamped.
const MINTED = new Set(['grantId', 'recordId', 'operationId', 'clientId', 'revokedAt']);
// A read's answer is the same on both surfaces bar the moment it was taken.
const READ_AT: ReadonlySet<string> = new Set(['checkedAt']);

/** Every grant and client row of both businesses, to show a refusal wrote nothing. */
const rows = async () => ({
  alpha: await rowsOf(harness.world.alpha),
  bravo: await rowsOf(harness.world.bravo),
});

/**
 * The refusals every read shares: without the key, bravo by prefix, the agent
 * route, a client. A stray field is answered alike, whatever the answer.
 */
async function readRefusals(verb: string): Promise<void> {
  const { world } = harness;
  refusedAlike(await both(verb, {}, world.mia.token), 403, 'SCOPE_NOT_GRANTED');
  refusedSame(await both(verb, {}, world.ada.token, { businessKey: 'bravo' }));
  refusedSame(await both(verb, {}, world.agent.token, { entry: 'agent' }));
  refusedSame(await both(verb, {}, clientToken));
  alike(await both(verb, { stray: true }, world.ada.token), READ_AT);
}

/** Tia given `task:comment` over one client, or the whole business with null. */
const grant = (clientId: string | null) => ({
  holderId: tia.personId,
  collection: 'task',
  action: 'comment',
  clientId,
});

/** A live `task:<action>` grant of the whole business, given by `token` in `key`; its id. */
const granted = async (
  action: string,
  token: string = harness.world.ada.token,
  key = 'alpha',
  holder: string = tia.personId,
): Promise<unknown> =>
  detailOf(
    await give({ holderId: holder, collection: 'task', action, clientId: null }, token, key),
  )['grantId'];

async function u14CliAccessRead(): Promise<void> {
  const { world } = harness;
  const own = await both('access.read', {}, world.ada.token);
  sameRecord(own, READ_AT);
  const alphaText = JSON.stringify(own.api.body);
  expect(alphaText, "alpha's preview lists its teammate").toContain(tia.personId);
  await readRefusals('access.read');
  // Bea reads bravo's preview on both: alike, and nothing of alpha's in it.
  const bravo = await both('access.read', {}, world.bea.token, { businessKey: 'bravo' });
  sameRecord(bravo, READ_AT);
  expect(JSON.stringify(bravo.cli.body)).not.toContain(tia.personId);
  expect(JSON.stringify(bravo.cli.body)).not.toContain(world.alpha);
}

async function u14CliAccessGrantApplies(): Promise<void> {
  const { world } = harness;
  const first = await createClient(`Cli Pilates ${randomUUID().slice(0, 6)}`);
  const second = await createClient(`Api Pilates ${randomUUID().slice(0, 6)}`);
  // One client given through each surface: the same grant bar its ids.
  const given = { cli: grant(first), api: grant(second) };
  sameRecord(await oneEach(world.api, 'access.grant', given, world.ada.token), MINTED);
  // The same grant again, on both: alike, whatever the answer.
  alike(await both('access.grant', grant(first), world.ada.token), MINTED);
}

async function u14CliAccessGrantRefuses(): Promise<void> {
  const { world } = harness;
  const bravoClient = await createClient(
    `Bravo Pilates ${randomUUID().slice(0, 6)}`,
    world.bea.token,
    'bravo',
  );
  const ada = world.ada.token;
  const before = await rows();
  // Without `access:manage`.
  refusedAlike(await both('access.grant', grant(null), world.mia.token), 403, 'SCOPE_NOT_GRANTED');
  // Another business: by prefix, a person of bravo by id, and bravo's client by id.
  refusedSame(await both('access.grant', grant(null), ada, { businessKey: 'bravo' }));
  refusedSame(await both('access.grant', { ...grant(null), holderId: world.bea.personId }, ada));
  refusedSame(await both('access.grant', grant(bravoClient), ada));
  // Unknown ids, a malformed field each, and the agent route.
  refusedSame(await both('access.grant', { ...grant(null), holderId: randomUUID() }, ada));
  refusedSame(await both('access.grant', grant(randomUUID()), ada));
  refusedSame(await both('access.grant', { ...grant(null), collection: 'nowhere' }, ada));
  refusedSame(await both('access.grant', { ...grant(null), action: 'fly' }, ada));
  refusedSame(await both('access.grant', { ...grant(null), clientId: 'not-an-id' }, ada));
  refusedSame(await both('access.grant', grant(null), world.agent.token, { entry: 'agent' }));
  expect(await rows(), 'no refusal wrote or changed a row').toStrictEqual(before);
}

async function u14CliAccessRevoke(): Promise<void> {
  const { world } = harness;
  const ada = world.ada.token;
  const first = await granted('read');
  const second = await granted('write');
  const pair = { cli: { grantId: first }, api: { grantId: second } };
  sameRecord(await oneEach(world.api, 'access.revoke', pair, ada), MINTED);

  const third = await granted('assign');
  const beas = await granted('read', world.bea.token, 'bravo', String(world.bea.personId));
  const before = await rows();
  refusedAlike(
    await both('access.revoke', { grantId: third }, world.mia.token),
    403,
    'SCOPE_NOT_GRANTED',
  );
  // Already revoked, never given, malformed.
  refusedSame(await both('access.revoke', { grantId: first }, ada));
  refusedSame(await both('access.revoke', { grantId: randomUUID() }, ada));
  refusedSame(await both('access.revoke', { grantId: 'not-an-id' }, ada));
  // Bea's grant, by id through alpha and by bravo's prefix; the agent route.
  refusedSame(await both('access.revoke', { grantId: beas }, ada));
  refusedSame(await both('access.revoke', { grantId: beas }, ada, { businessKey: 'bravo' }));
  refusedSame(
    await both('access.revoke', { grantId: third }, world.agent.token, { entry: 'agent' }),
  );
  expect(await rows(), 'no refusal wrote or changed a row').toStrictEqual(before);
}

async function u14CliOperationsRead(): Promise<void> {
  sameRecord(await both('operations.read', {}, harness.world.ada.token), READ_AT);
  await readRefusals('operations.read');
}

describe.skipIf(serverUrl === undefined)('U14 on the command line', () => {
  it(
    'U14 CLI access.read: the command line gives the same preview and the same refusals as the API',
    u14CliAccessRead,
  );
  it('U14 CLI access.grant: the command line gives the same grant and the same refusals as the API', async () => {
    await u14CliAccessGrantApplies();
    await u14CliAccessGrantRefuses();
  });
  it(
    'U14 CLI access.revoke: the command line gives the same revocation and the same refusals as the API',
    u14CliAccessRevoke,
  );
  it(
    'U14 CLI operations.read: the command line gives the same service health and the same refusals as the API',
    u14CliOperationsRead,
  );
});

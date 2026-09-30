// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 (CS-2.15): `access.read` carries each listed person's live grants by id,
// so Settings ▸ Access can revoke one grant with `access.revoke` (the tracked
// action `grant changed` under `access:manage`). Only the caller's business's
// grants are listed, filtered inside the query; another business's grant id
// never reaches an alpha body, refusals included, and revoking it from alpha
// is answered exactly as an id that exists nowhere.
//
// The world is `c32-clients-world.ts`: Ada is alpha's owner, Mia holds no
// `access:manage`, Tia is a teammate with no grant, Bea is bravo's with
// `access:manage` there, and the agent acts under a live delegation from Ada.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl, type Answer } from '../acceptance/world.ts';
import {
  as,
  createClient,
  credential,
  detailOf,
  give,
  harness,
  outcome,
  revoke,
  rowsOf,
  tia,
  useClientsWorld,
} from './c32-clients-world.ts';

useClientsWorld();

interface Listed {
  readonly personId: string;
  readonly grants: readonly {
    readonly grantId: string;
    readonly collection: string;
    readonly action: string;
    readonly scope: { readonly kind: string; readonly id: string | null };
  }[];
}

const read = async (token = harness.world.ada.token, key = 'alpha'): Promise<Answer> =>
  await as('/access/read', {}, token, key);

const grantsOf = (answer: Answer, personId: string): Listed['grants'] => {
  const people = [
    ...(answer.body['team'] as readonly Listed[]),
    ...(answer.body['clients'] as readonly Listed[]),
  ];
  return people.find((person) => person.personId === personId)?.grants ?? [];
};

async function listedByIdAndRevocable(): Promise<void> {
  const clientA = await createClient(`Grant ids A ${randomUUID()}`);
  const given = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: clientA,
  });
  expect(outcome(given)).toEqual({ status: 200, code: 'ok' });
  const grantId = String(detailOf(given)['grantId']);

  const before = await read();
  expect(before.status).toBe(200);
  expect(grantsOf(before, tia.personId)).toEqual([
    { grantId, collection: 'task', action: 'read', scope: { kind: 'party', id: clientA } },
  ]);

  expect(outcome(await revoke(grantId))).toEqual({ status: 200, code: 'ok' });
  const after = await read();
  expect(grantsOf(after, tia.personId)).toEqual([]);
  expect(JSON.stringify(after.body)).not.toContain(grantId);
}

/** Bea's grant in bravo, whose id is the canary alpha must never see. */
async function bravoCanary(): Promise<string> {
  const { world } = harness;
  const given = await give(
    { holderId: world.bea.personId, collection: 'task', action: 'read' },
    world.bea.token,
    'bravo',
  );
  expect(outcome(given)).toEqual({ status: 200, code: 'ok' });
  const grantId = String(detailOf(given)['grantId']);
  expect(JSON.stringify((await read(world.bea.token, 'bravo')).body)).toContain(grantId);
  return grantId;
}

/** A person under a live delegation: the agent neither reads nor revokes. */
async function agentAnswers(grantId: string): Promise<Answer[]> {
  const { world } = harness;
  const answers: Answer[] = [];
  for (const [path, body] of [
    ['/access/read', {}],
    ['/access/revoke', { operationId: randomUUID(), grantId }],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    const agent = await call(world.api, agentPath('alpha', path), body, {
      ...bearer(world.agent.token),
      [DELEGATION_HEADER]: credential,
    });
    expect(outcome(agent), path).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
    answers.push(agent);
  }
  return answers;
}

const withoutIds = (answer: Answer): string => answer.text.replaceAll(/"[0-9a-f-]{36}"/gu, '""');

async function isolation(): Promise<void> {
  const { world } = harness;
  const bravoGrant = await bravoCanary();
  const bravoBefore = await rowsOf(world.bravo);

  // Another client in the same business: Tia holds client A only.
  const clientA = await createClient(`Iso A ${randomUUID()}`);
  const clientB = await createClient(`Iso B ${randomUUID()}`);
  const onA = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: clientA,
  });
  const onAId = String(detailOf(onA)['grantId']);
  const listed = await read();
  expect(grantsOf(listed, tia.personId).map((grant) => grant.scope)).toEqual([
    { kind: 'party', id: clientA },
  ]);
  expect(JSON.stringify(grantsOf(listed, tia.personId))).not.toContain(clientB);

  const alphaBefore = await rowsOf(world.alpha);
  const unknown = await revoke(randomUUID());
  const across = await revoke(bravoGrant);
  expect(outcome(across)).toEqual(outcome(unknown));
  expect(withoutIds(across)).toBe(withoutIds(unknown));
  // Person to person (Mia holds no access:manage), and alpha's owner through bravo's prefix.
  const mia = [await read(world.mia.token), await revoke(onAId, world.mia.token)];
  const prefixed = [
    await read(world.ada.token, 'bravo'),
    await revoke(bravoGrant, world.ada.token, 'bravo'),
  ];
  expect(mia.map((answer) => outcome(answer))).toEqual([
    { status: 403, code: 'SCOPE_NOT_GRANTED' },
    { status: 403, code: 'SCOPE_NOT_GRANTED' },
  ]);
  for (const answer of prefixed) expect(answer.status).toBeGreaterThanOrEqual(400);

  const answers = [listed, unknown, across, ...mia, ...prefixed, ...(await agentAnswers(onAId))];
  for (const answer of answers) expect(answer.text).not.toContain(bravoGrant);
  expect(await rowsOf(world.alpha)).toEqual(alphaBefore);
  expect(await rowsOf(world.bravo)).toEqual(bravoBefore);
}

describe.skipIf(serverUrl === undefined)('C32 grants by id on Settings ▸ Access', () => {
  it(
    'C32 grant ids: each listed person carries their live grants by id, and revoking one by that id takes it off the next read',
    listedByIdAndRevocable,
  );

  it(
    "C32 grant ids isolation: another business's grant id never reaches alpha and is revoked like an unknown id; another client's is never listed; neither Mia nor a delegated agent reads or revokes",
    isolation,
  );
});

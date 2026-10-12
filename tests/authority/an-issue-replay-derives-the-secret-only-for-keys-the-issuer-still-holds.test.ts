// SPDX-License-Identifier: AGPL-3.0-only
//
// The issuer's replay of `credential.issue` derives the secret again, so it
// is an issue of that credential once more and is judged as one: each ticked
// key walked against the issuer's grants as they are now. An issuer who has
// lost a ticked key since is refused `CREDENTIAL_SCOPE_WIDENS` and gets no
// secret back; one who still holds every key gets the same secret.

import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { codeOf, detailOf, issueAs, issueBody, issuerIn } from './agent-credential-issuer.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credreplaykeys');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

it('a replay of an issue whose ticked key the issuer has lost returns no secret', async () => {
  const issuer = await issuerIn(world);
  const body = issueBody();
  const first = await issueAs(world, issuer, body);
  expect(isCommandRefusal(first), JSON.stringify(first)).toBe(false);
  expect(typeof detailOf(first)['credential']).toBe('string');

  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await revokeGrant(tx, issuer.grants['task:write'] ?? '');
  });
  const replay = await issueAs(world, issuer, body);
  expect(JSON.stringify(replay)).not.toContain(String(detailOf(first)['credential']));
  expect(codeOf(replay)).toBe('CREDENTIAL_SCOPE_WIDENS');
}, 60_000);

it('a replay of an issue whose ticked keys the issuer still holds returns the same secret', async () => {
  const issuer = await issuerIn(world);
  const body = issueBody();
  const first = await issueAs(world, issuer, body);
  const replay = await issueAs(world, issuer, body);
  expect(isCommandRefusal(replay), JSON.stringify(replay)).toBe(false);
  expect(detailOf(replay)['credential']).toBe(detailOf(first)['credential']);
}, 60_000);

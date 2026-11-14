// SPDX-License-Identifier: AGPL-3.0-only
//
// `credential.issue` refuses every key no agent may hold (the catalogue's
// "no" keys and the money set), but that is judged at issue. A credential
// written before that refusal existed, or around it, still carries such a key
// in its row. At use the door gives the agent none of them: the call stands
// within the row's other keys only, so `session.capabilities` lists none of
// them even while the person holds the grant. Noah holds each planted key
// from this file, so a key that is missing is missing for the agent's rule,
// not for want of a grant.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  configuredCredentialKeys,
  issueAgentCredential,
  type Action,
  type CredentialKey,
} from '../../packages/core-records/src/index.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential } from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);

/** Keys an agent may never hold that a credential row can still carry. */
const NEVER: readonly CredentialKey[] = [
  { collection: 'operations', action: 'read' },
  { collection: 'conversation', action: 'read' },
  { collection: 'chat', action: 'comment' },
  { collection: 'billing', action: 'read' },
];

const pairsOf = (answer: Answer): string[] =>
  ((answer.body['grants'] ?? []) as readonly { collection: string; action: string }[])
    .map((one) => `${one.collection}:${one.action}`)
    .toSorted();

let secret: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const noah = harness.world.noah as unknown as Member;
  const keys = configuredCredentialKeys();
  if (!keys.ok) throw new Error('no delegation credential keyring');
  secret = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    for (const key of NEVER) {
      // oxlint-disable-next-line no-await-in-loop -- one grant per key, in order
      await grantTo(tx, noah, key.action as Action, WHOLE_BUSINESS, false, key.collection);
    }
    // The row as one issued before the refusal: written past `credential.issue`.
    const planted = await issueAgentCredential(tx, keys.keys, {
      personId: noah.personId,
      actorId: noah.actorId,
      purpose: `planted_${randomUUID().slice(0, 8)}`,
      scope: [{ collection: 'task', action: 'read' }, ...NEVER],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return planted.credential;
  });
});

needsServer(
  'a credential row holding keys no agent may hold is given none of them at use',
  async () => {
    const asNoah = await harness.asPerson('session.capabilities', {}, 'alpha', harness.world.noah);
    expect(asNoah.code, asNoah.text).toBe('ok');
    expect(pairsOf(asNoah), 'noah holds every planted key').toEqual(
      expect.arrayContaining([
        'task:read',
        ...NEVER.map((key) => `${key.collection}:${key.action}`),
      ]),
    );

    const asked = await asCredential('session.capabilities', {}, bearer(secret));
    expect(asked.code, asked.text).toBe('ok');
    expect(pairsOf(asked), 'only the key an agent may hold').toStrictEqual(['task:read']);
  },
);

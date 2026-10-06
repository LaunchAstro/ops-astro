// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #764: a credential that is not live gets the same answers at a
// business key that exists and at one nobody holds, including once the door's
// count of not-live bearers is spent. The door's own limits are in
// `api-2-agent-credential-door.test.ts`.

import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, type Api } from './api-2-agent-credential-use-world.ts';
import { limited } from './api-2-agent-credential-quota-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);

const madeUp = (): string => randomBytes(32).toString('base64url');

const knock = async (api: Api, businessKey: string): Promise<Answer> =>
  await asCredential(
    'task.read',
    { recordId: harness.alphaTask.id },
    bearer(madeUp()),
    api,
    businessKey,
  );

/** Status and raw body, the whole of what a caller can compare. */
const seen = (answer: Answer): string => `${answer.status} ${answer.text}`;

/** Three not-live bearers at a key at once, past a door of two: what each was answered, sorted. */
const threeAt = async (api: Api, businessKey: string): Promise<string[]> =>
  (
    await Promise.all(Array.from({ length: 3 }, async () => seen(await knock(api, businessKey))))
  ).toSorted();

needsServer(
  'API-2 door: a not-live credential answers the same at a key that exists and at one nobody holds, past the door’s count too',
  async () => {
    const { api, tick } = limited({ refused: 2 });
    const fabricated = `zulu-${randomUUID()}`;
    const known = await threeAt(api, 'alpha');
    expect(
      known.filter((answer) => answer.startsWith('429 ')),
      'the door is spent',
    ).toHaveLength(1);
    expect(await threeAt(api, fabricated)).toEqual(known);
    tick(61_000);
    expect(await threeAt(api, fabricated), 'the next window').toEqual(await threeAt(api, 'alpha'));
  },
);

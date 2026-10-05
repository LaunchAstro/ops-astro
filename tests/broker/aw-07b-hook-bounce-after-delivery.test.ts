// SPDX-License-Identifier: AGPL-3.0-only
// A delivery receipt means the receiving server accepted the message; a later
// permanent bounce must still be retained. Neither arrival order may lose it.

import { expect, it as vitestIt } from 'vitest';
import { attemptsOf, noDatabase, useEmailWorld } from './email-world.ts';
import { eventBody, mountHook, post, sentItem } from './email-hook-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useEmailWorld();

it('AW-07b hook signature: a signed bounce after delivery is retained as a failed observation', async () => {
  mountHook();
  const { item, messageId } = await sentItem();
  expect(await post(eventBody('email.delivered', messageId))).toMatchObject({ code: 'DELIVERED' });
  expect((await attemptsOf(item)).map((row) => row.state)).toEqual([
    'asked',
    'accepted',
    'delivered',
  ]);
  // A receiving server can initially accept mail, then fail its later delivery.
  // The bounce is independently signed and has its own event id.
  expect(await post(eventBody('email.bounced', messageId))).toMatchObject({ code: 'BOUNCED' });
  expect((await attemptsOf(item)).at(-1)).toMatchObject({ state: 'failed' });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// An inbox email's `asked` holds a place under `email.send`'s one ceiling until
// custody's timeout and a grace have passed. The send checks its fence before
// it asks custody, but a send that then waited on its way out (the hop to
// custody, or custody's own queue) past that bound would go out beside the
// email that took its place. Custody is told when the place ends, so such a
// send is never made, and its item records the refusal, which proves nothing
// went.

import { expect, it as vitestIt } from 'vitest';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { IN_FLIGHT_GRACE_MS } from '../../packages/core-custody/src/email-class.ts';
import { custodyAhead } from './custody-clock-ahead.ts';
import { freshInbox, useTimingWorld } from './email-timing-world.ts';
import {
  attemptsOf,
  itemFor,
  MAIL,
  noDatabase,
  TEST_EMAIL_SEND,
  useEmailWorld,
  w,
} from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

it('an inbox email that reaches custody after its place under the ceiling has ended is never sent', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.received.length;
  const result = await custodyAhead(
    TEST_EMAIL_SEND.timeoutMs + IN_FLIGHT_GRACE_MS,
    async () => await sendInboxEmail(w.db.app, w.alpha, item, w.broker, MAIL),
  );
  expect({
    result,
    attempts: await attemptsOf(item),
    sent: w.provider.received.length - before,
  }).toMatchObject({
    result: { ok: false, code: 'EMAIL_FAILED', fault: 'refused' },
    attempts: [
      { state: 'asked', evidence: null },
      { state: 'failed', evidence: 'refused' },
    ],
    sent: 0,
  });
});

it('an inbox email that reaches custody inside its place is sent', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'decision');
  const result = await custodyAhead(
    IN_FLIGHT_GRACE_MS - 20_000,
    async () => await sendInboxEmail(w.db.app, w.alpha, item, w.broker, MAIL),
  );
  expect(result).toMatchObject({ ok: true, state: 'accepted' });
});

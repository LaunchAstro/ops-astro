// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: mail is refused until the installation's sending subdomain
// verifies. A report that verified one subdomain says nothing about mail sent
// from an address on another domain, so the send must refuse it before the
// provider sees anything.

import { expect, it as vitestIt } from 'vitest';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

it('AW-07b sender: mail from an address outside the verified sending subdomain is refused, nothing sent', async () => {
  w.provider.mode('accept');
  // The report verified send.example.test only (MAIL.sender).
  expect(MAIL.sender).toMatchObject({ subdomain: 'send.example.test', verified: true });
  // Another domain and the bare root (published-safe forms, public-content-check.mjs).
  for (const from of ['hello@example.com', 'hello@example.test']) {
    const item = await itemFor(w.task, 'decision'); // oxlint-disable-line no-await-in-loop
    const received = w.provider.received.length;
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, { ...MAIL, from });
    expect(sent, from).toEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
    expect(w.provider.received.length, from).toBe(received);
    expect(await attemptsOf(item), from).toEqual([]); // oxlint-disable-line no-await-in-loop
  }
});

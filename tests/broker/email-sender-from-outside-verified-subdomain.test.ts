// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: mail is refused until the installation's sending subdomain
// verifies. A report that verified one subdomain says nothing about mail sent
// from an address on another domain, so the send must refuse it before the
// provider sees anything.

import { expect, it as vitestIt } from 'vitest';
import { sendInboxEmail, type MailSettings } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

/** Mail from each is refused SENDER_NOT_VERIFIED: nothing reaches the provider, no attempt row. */
async function refusedNothingSent(froms: readonly string[], base = MAIL): Promise<void> {
  w.provider.mode('accept');
  const seen = [];
  for (const from of froms) {
    const item = await itemFor(w.task, 'decision'); // oxlint-disable-line no-await-in-loop
    const received = w.provider.received.length;
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, { ...base, from });
    const reached = w.provider.received.length - received;
    seen.push({ from, sent, reached, attempts: await attemptsOf(item) }); // oxlint-disable-line no-await-in-loop
  }
  const refused = { ok: false, code: 'SENDER_NOT_VERIFIED' };
  expect(seen).toEqual(froms.map((from) => ({ from, sent: refused, reached: 0, attempts: [] })));
}

/** A subdomain of 141 + n octets in labels of at most 63, under the published-safe example.test. */
function long(n: number): string {
  return `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(n)}.example.test`;
}

/** The mail settings send: the provider accepts it. */
async function sends(mail: MailSettings): Promise<void> {
  w.provider.mode('accept');
  const item = await itemFor(w.task, 'decision');
  const sent = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, mail);
  expect(sent, mail.from).toMatchObject({ ok: true, state: 'accepted' });
}

it('AW-07b sender: mail from an address outside the verified sending subdomain is refused, nothing sent', async () => {
  // The report verified send.example.test only (MAIL.sender).
  expect(MAIL.sender).toMatchObject({ subdomain: 'send.example.test', verified: true });
  // Another domain and the bare root (published-safe forms, public-content-check.mjs).
  await refusedNothingSent(['hello@example.com', 'hello@example.test']);
});

it('AW-07b sender: a from that is not one local part, one @ and the verified subdomain is refused, nothing sent', async () => {
  const subdomain = MAIL.sender.subdomain;
  // The bare subdomain, an empty local part, and a second @ ahead of it.
  await refusedNothingSent([subdomain, `@${subdomain}`, `hello@other@${subdomain}`]);
});

it('AW-07b sender: a from whose local part is not a bare ASCII dot-atom is refused, nothing sent', async () => {
  const subdomain = MAIL.sender.subdomain;
  // A display name, a leading space, a header injected by a line break, a double and a leading dot.
  await refusedNothingSent([
    `Bank <a@${subdomain}`,
    ` a@${subdomain}`,
    `a\r\nBcc: v@${subdomain}`,
    `a..b@${subdomain}`,
    `.a@${subdomain}`,
  ]);
  // A dot-atom with a dot and a plus still sends.
  await sends({ ...MAIL, from: `a.b+c@${subdomain}` });
});

it('AW-07b sender: a from whose domain only lower-cases to the subdomain is refused, nothing sent', async () => {
  const sender = { ...MAIL.sender, subdomain: 'mail.kiwi.example' };
  // The Kelvin sign (U+212A) lower-cases to k: not ASCII, so not the verified subdomain.
  await refusedNothingSent(['x@mail.\u212Aiwi.example'], { ...MAIL, sender });
  await sends({ ...MAIL, sender, from: `x@${sender.subdomain}` });
});

it('AW-07b sender: a mock setup report never verifies a real send, nothing sent', async () => {
  // The world's sender is a real verified report; the same report marked mock is not.
  expect(MAIL.sender).toMatchObject({ verified: true, mock: false });
  await refusedNothingSent([MAIL.from], { ...MAIL, sender: { ...MAIL.sender, mock: true } });
});

it('AW-07b sender: a verified report that does not say it is not mock is refused, nothing sent', async () => {
  const sender = { ...MAIL.sender };
  Reflect.deleteProperty(sender, 'mock');
  expect(sender).toMatchObject({ verified: true });
  expect('mock' in sender).toBe(false);
  await refusedNothingSent([MAIL.from], { ...MAIL, sender });
});

it('AW-07b sender: a from over 64 octets of local part or 254 octets in all is refused, nothing sent; exactly 64 and 254 send', async () => {
  // RFC 5321 4.5.3.1: a local part is at most 64 octets, a whole address at most 254. The gate
  // already takes ASCII only, so each character here is one octet.
  const subdomain = MAIL.sender.subdomain;
  const local65 = `${'a'.repeat(65)}@${subdomain}`;
  const local64 = `${'a'.repeat(64)}@${subdomain}`;
  await refusedNothingSent([local65]);
  await sends({ ...MAIL, from: local64 });

  // A verified subdomain long enough to reach the whole-address limit with a 64-octet local part.
  const over = { ...MAIL.sender, subdomain: long(49) };
  const at = { ...MAIL.sender, subdomain: long(48) };
  const address255 = `${'a'.repeat(64)}@${over.subdomain}`;
  const address254 = `${'a'.repeat(64)}@${at.subdomain}`;
  expect([address255.length, address254.length]).toEqual([255, 254]);
  await refusedNothingSent([address255], { ...MAIL, sender: over });
  await sends({ ...MAIL, sender: at, from: address254 });
});

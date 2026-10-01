// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs for AW-07b's email send (reviewer, uncommitted).

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import {
  sendInboxEmail,
  startCustody,
  type Broker,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import { itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

/** A provider of the test's own: answers every request with `answer` after `delayMs`, counting peak in flight. */
async function ownProvider(
  answer: (res: import('node:http').ServerResponse) => void,
  delayMs = 0,
): Promise<{ origin: string; received: () => number; peak: () => number; server: Server }> {
  let received = 0;
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    received += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        inFlight -= 1;
        answer(res);
      }, delayMs);
    });
  });
  // oxlint-disable-next-line eslint/no-promise-executor-return -- the reviewer's proof, kept as written
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received: () => received,
    peak: () => peak,
    server,
  };
}

/** Custody of the test's own over `origin`, and the world's broker with it. */
async function brokerOver(
  origin: string,
): Promise<{ broker: Broker; custody: Custody; done: () => Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), 'sol-aw07b-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'email_key',
        destination: 'email',
        kind: 'api_key',
        account: 'mail-1',
        header: 'authorization',
        value: `mailkey-${randomBytes(18).toString('hex')}`,
      },
    ]),
    { mode: 0o600 },
  );
  const custody = await startCustody({ credentialsFile, destinations: [{ key: 'email', origin }] });
  return {
    broker: { ...w.broker, custody },
    custody,
    done: async () => {
      await custody.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

it('a provider 5xx is not positive proof nothing was sent, so no second email goes', async () => {
  const provider = await ownProvider((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'internal_server_error' }));
  });
  const { broker, done } = await brokerOver(provider.origin);
  try {
    const item = await itemFor(w.task, 'incident');
    const first = await sendInboxEmail(w.db.app, w.alpha, item, broker, MAIL);
    expect(first).toMatchObject({ ok: false, code: 'EMAIL_FAILED' });
    // The provider had the message and answered 500: it may have sent it.
    // The broker's own settle rule (broker-settle.ts) calls any non-ok answer
    // unknown; only a declared `nothingHappened` code is proof.
    const second = await sendInboxEmail(w.db.app, w.alpha, item, broker, MAIL);
    expect(second).toEqual({ ok: false, code: 'EMAIL_MAY_HAVE_GONE' });
    expect(provider.received()).toBe(1);
  } finally {
    await done();
    provider.server.closeAllConnections();
    // oxlint-disable-next-line eslint/no-promise-executor-return -- the reviewer's proof, kept as written
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
  }
});

it('a redirect is an answer from a provider that had the message, so no second email goes', async () => {
  w.provider.mode('redirect');
  const item = await itemFor(w.task, 'incident');
  const before = w.provider.received.length;
  await sendInboxEmail(w.db.app, w.alpha, item, w.broker, MAIL);
  w.provider.mode('accept');
  const again = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, MAIL);
  expect(again).toEqual({ ok: false, code: 'EMAIL_MAY_HAVE_GONE' });
  expect(w.provider.received.length - before).toBe(1);
});

it('the catalogued concurrency of email.send bounds the sends in flight for one business', async () => {
  const provider = await ownProvider((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: randomUUID() }));
  }, 300);
  const { broker, done } = await brokerOver(provider.origin);
  try {
    const items: string[] = [];
    for (let n = 0; n < 2 * EMAIL_SEND.concurrency; n += 1) {
      // oxlint-disable-next-line no-await-in-loop
      items.push(await itemFor(w.task, 'incident'));
    }
    await Promise.all(
      items.map(async (item) => await sendInboxEmail(w.db.app, w.alpha, item, broker, MAIL)),
    );
    expect(provider.peak()).toBeLessThanOrEqual(EMAIL_SEND.concurrency);
  } finally {
    await done();
    provider.server.closeAllConnections();
    // oxlint-disable-next-line eslint/no-promise-executor-return -- the reviewer's proof, kept as written
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
  }
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender, mock delivery (SEC10 A2 kept): a mock setup report verifies a
// send only when the send's custody is the one core-custody started for the
// fake provider on this machine (`startLoopbackMockCustody`). The same mock
// report over any other custody, one on a provider that is not on this
// machine, the world's own unmarked custody, or a copy of the marked one, is
// refused SENDER_NOT_VERIFIED: nothing reaches a provider and no row is kept.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  sendInboxEmail,
  startCustody,
  startLoopbackMockCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

/** Unresolvable by design (.test): even a gate that let it through could reach nothing real. */
const NOT_HERE = 'https://mail.example.test';
const MOCK = { ...MAIL, sender: { ...MAIL.sender, mock: true } };

let folder = '';
let credentialsFile = '';
const started: Custody[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'aw07b-mock-gate-'));
  credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'mail-1', header: 'authorization', value: w.key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ref: 'email_key', destination: 'email', ...credential }]),
    { mode: 0o600 },
  );
});

afterAll(async () => {
  await Promise.all(started.map(async (custody) => await custody.stop()));
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

async function custodyOver(origin: string, marked: boolean): Promise<Custody> {
  const destination = { key: 'email', origin };
  const custody = marked
    ? await startLoopbackMockCustody(credentialsFile, destination)
    : await startCustody({ credentialsFile, destinations: [destination] });
  started.push(custody);
  return custody;
}

it('AW-07b mock gate: a mock report sends over the loopback mock custody core-custody started', async () => {
  w.provider.mode('accept');
  const custody = await custodyOver(w.provider.origin, true);
  const item = await itemFor(w.task, 'decision');
  const received = w.provider.received.length;
  const sent = await sendInboxEmail(w.db.app, w.alpha, item, { ...w.broker, custody }, MOCK);
  expect(sent).toMatchObject({ ok: true, state: 'accepted' });
  expect(w.provider.received.length).toBe(received + 1);
  expect((await attemptsOf(item)).map((row) => row.state)).toEqual(['asked', 'accepted']);
});

it('AW-07b mock gate: a mock report over a provider not on this machine is refused, nothing sent', async () => {
  w.provider.mode('accept');
  const elsewhere = await custodyOver(NOT_HERE, false);
  const marked = await custodyOver(w.provider.origin, true);
  const cases: readonly (readonly [string, Custody])[] = [
    ['custody on a provider not on this machine', elsewhere],
    ["the world's custody, on loopback but not started as the mock", w.custody],
    ['a copy of the marked custody', { ...marked }],
  ];
  for (const [name, custody] of cases) {
    const item = await itemFor(w.task, 'decision'); // oxlint-disable-line no-await-in-loop
    const received = w.provider.received.length;
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendInboxEmail(w.db.app, w.alpha, item, { ...w.broker, custody }, MOCK);
    expect(sent, name).toEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
    expect(w.provider.received.length, name).toBe(received);
    expect(await attemptsOf(item), name).toEqual([]); // oxlint-disable-line no-await-in-loop
  }
});

vitestIt(
  'AW-07b mock gate: the loopback mock custody starts for no provider off this machine',
  async () => {
    for (const origin of [NOT_HERE, 'http://localhost:9', 'https://127.0.0.1.example.test']) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(custodyOver(origin, true), origin).rejects.toThrow('not on this machine');
    }
  },
);

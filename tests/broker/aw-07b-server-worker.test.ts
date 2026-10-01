// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker as the server runs it. `apps/api/server.ts` is
// started as its own OS process with mock mail delivery on, against the email
// world's database and fake provider: a decision waiting in the business it
// recovers goes out through custody without any test calling the worker, and
// SIGTERM ends the process cleanly. The worker's own stop is shown in process.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { mailDeliverySettings, startMailDelivery } from '../../apps/api/mail-delivery.ts';
import { serveApi, type Served } from '../support/served-api.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

let folder = '';
let credentialsFile = '';

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'aw07b-server-'));
  credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'mail-1', header: 'authorization', value: w.key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ref: 'email_key', destination: 'email', ...credential }]),
    { mode: 0o600 },
  );
  if (noDatabase) return;
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active) values ($1, $2, 'worker', null, true)`,
      [tx.businessId, randomUUID()],
    );
  });
});

afterAll(() => {
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

/** The production entry over the world's database, recovering alpha, with `settings` added. */
const serve = async (settings: Readonly<Record<string, string>>): Promise<Served> =>
  await serveApi(w.db, 'alpha', settings);

const mockDelivery = (): Record<string, string> => ({
  MAIL_DELIVERY: 'mock',
  MAIL_PROVIDER_ORIGIN: w.provider.origin,
  MAIL_CREDENTIALS_FILE: credentialsFile,
  MAIL_APP_ORIGIN: MAIL.appOrigin,
  MAIL_FROM: MAIL.from,
});

it('AW-07b server worker: the server starts the mail worker, which mails a waiting decision, and stops with it', async () => {
  const decision = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const served = await serve(mockDelivery());
  try {
    expect(served.ready, served.output()).toBe(true);
    await expect
      .poll(async () => (await attemptsOf(decision)).map((row) => row.state), {
        timeout: 40_000,
        interval: 500,
      })
      .toEqual(['asked', 'accepted']);
    expect(w.provider.outbox.length).toBe(before + 1);
  } finally {
    expect(await served.stop()).toBe(0);
  }
  expect(served.output()).toContain('api: mail delivery mock');
  expect(served.output()).not.toContain(w.canary.split('@')[0]);
}, 90_000);

it('AW-07b server worker: mail delivery set in any form but off or mock stops the server before it listens', async () => {
  const served = await serve({ ...mockDelivery(), MAIL_DELIVERY: 'on' });
  expect(served.ready).toBe(false);
  expect(await served.stop()).toBe(1);
  expect(served.output()).toContain('MAIL_DELIVERY');
  expect(served.output()).not.toContain('api: listening');
}, 60_000);

const settle = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
};

it('AW-07b server worker: once its stop is called, the delivery sends nothing more', async () => {
  const settings = mailDeliverySettings(mockDelivery());
  if (settings.kind !== 'mock') throw new Error(`mail delivery settings: ${settings.kind}`);
  const first = await itemFor(w.task, 'decision');
  const delivery = await startMailDelivery(
    settings,
    w.db.app,
    async () => await Promise.resolve([w.alpha]),
    { atOnceMs: 50, dailyTickMs: 80 },
  );
  try {
    await expect
      .poll(async () => (await attemptsOf(first)).map((row) => row.state), { timeout: 10_000 })
      .toEqual(['asked', 'accepted']);
  } finally {
    await delivery.stop();
  }
  // A pass already running given time to end, then a new decision waits unsent.
  await settle();
  const after = await itemFor(w.task, 'decision');
  await settle();
  expect(await attemptsOf(after)).toEqual([]);
}, 30_000);

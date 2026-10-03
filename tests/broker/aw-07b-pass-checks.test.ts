// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker, checked at every pass (SEC28 F2): the sending
// subdomain's setup check is read again at the start of each pass, so a
// sender that stops verifying stops the next pass's sends. Its refusal is the
// send's own SENDER_NOT_VERIFIED, which writes nothing: no attempt row, and
// nothing reaches the provider.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { mailDeliverySettings, startMailDelivery } from '../../apps/api/mail-delivery.ts';
import type { SenderReport } from '../../packages/core-connectors/src/index.ts';
import {
  attemptsOf,
  itemFor,
  MAIL,
  noDatabase,
  useEmailWorld,
  VERIFIED_SENDER,
  w,
} from './email-world.ts';
import { freshInbox } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

let folder = '';
let credentialsFile = '';

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'aw07b-pass-checks-'));
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

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const states = async (item: string): Promise<string[]> =>
  (await attemptsOf(item)).map((row) => row.state);

it('AW-07b delivery worker: a sender that turns unverified between passes stops the next pass sending', async () => {
  await freshInbox();
  const settings = mailDeliverySettings({
    MAIL_DELIVERY: 'mock',
    MAIL_PROVIDER_ORIGIN: w.provider.origin,
    MAIL_CREDENTIALS_FILE: credentialsFile,
    MAIL_APP_ORIGIN: MAIL.appOrigin,
    MAIL_FROM: MAIL.from,
  });
  if (settings.kind !== 'mock') throw new Error(`mail delivery settings: ${settings.kind}`);
  // The setup check, as a later real source would answer it: verified until it is not.
  let verified = true;
  let checks = 0;
  const sender = async (subdomain: string): Promise<SenderReport> => {
    checks += 1;
    return await Promise.resolve({ ...VERIFIED_SENDER, subdomain, mock: true, verified });
  };
  const first = await itemFor(w.task, 'decision');
  const delivery = await startMailDelivery(
    settings,
    w.db.app,
    async () => await Promise.resolve([w.alpha]),
    { atOnceMs: 50, dailyTickMs: 60_000 },
    sender,
  );
  try {
    await expect
      .poll(async () => await states(first), { timeout: 10_000 })
      .toEqual(['asked', 'accepted']);
    const before = w.provider.received.length;
    verified = false;
    // Passes enough for one begun after the change to have ended, then a new decision waits.
    const changed = checks;
    await settle(400);
    const second = await itemFor(w.task, 'decision');
    await settle(800);
    expect(await attemptsOf(second), 'a pass sent after the sender turned unverified').toEqual([]);
    expect(checks, 'the sender check was not read again').toBeGreaterThan(changed + 1);
    expect(w.provider.received.length).toBe(before);
  } finally {
    await delivery.stop();
  }
}, 40_000);

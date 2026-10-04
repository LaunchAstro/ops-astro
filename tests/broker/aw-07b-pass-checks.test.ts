// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker, checked at every pass (SEC28 F2): the sending
// subdomain's setup check is read again at the start of each pass, so a
// sender that stops verifying stops the next pass's sends. Its refusal is the
// send's own SENDER_NOT_VERIFIED, which writes nothing: no attempt row, and
// nothing reaches the provider. And stopped between sends (SEC28 F5): a
// worker stopped while one business has several items due starts no send
// after the stop; the item already asked is left as it is, never sent twice.
// Deactivated between sends, likewise: the worker's standing is read again in
// each send's own transaction, so a worker deactivated while its first send is
// with custody asks for no second, and the pass answers WORKER_REQUIRED.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { mailDeliverySettings, startMailDelivery } from '../../apps/api/mail-delivery.ts';
import type { SenderReport } from '../../packages/core-connectors/src/index.ts';
import {
  deliverDue,
  startMailWorker,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import {
  attemptsOf,
  itemFor,
  MAIL,
  noDatabase,
  useEmailWorld,
  VERIFIED_SENDER,
  w,
} from './email-world.ts';
import { freshInbox, preferences } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

let folder = '';
let credentialsFile = '';
let workerActor = '';

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
  workerActor = randomUUID();
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active) values ($1, $2, 'worker', null, true)`,
      [tx.businessId, workerActor],
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

it('AW-07b delivery worker: stopped during a business with several items due, no send starts after', async () => {
  await freshInbox();
  const items = [
    await itemFor(w.task, 'decision'),
    await itemFor(w.task, 'decision'),
    await itemFor(w.task, 'decision'),
  ];
  const before = w.provider.received.length;
  let dispatches = 0;
  let stopping: Promise<void> | undefined;
  // The first send stops the worker while it is in flight, then goes on to the provider.
  const custody: Custody = {
    ...w.custody,
    dispatch: async (credentialRef, request) => {
      dispatches += 1;
      stopping ??= worker.stop();
      return await w.custody.dispatch(credentialRef, request);
    },
  };
  const timing = { broker: { ...w.broker, custody }, mail: MAIL, preferences };
  const worker = startMailWorker(
    w.db.app,
    async () => await Promise.resolve([{ businessId: w.alpha, workerActorId: workerActor }]),
    async () => await Promise.resolve(timing),
    { atOnceMs: 50, dailyTickMs: 60_000 },
  );
  await expect.poll(() => stopping !== undefined, { timeout: 10_000 }).toBe(true);
  await stopping;
  await settle(300);
  expect(dispatches, 'a send started after the stop').toBe(1);
  expect(w.provider.received.length).toBe(before + 1);
  const sent = await Promise.all(items.map(async (item) => await states(item)));
  expect(sent.filter((rows) => rows.length > 0)).toEqual([['asked', 'accepted']]);
}, 30_000);

it('AW-07b delivery worker: deactivated while its first send is with custody, it sends nothing further', async () => {
  await freshInbox();
  const actor = randomUUID();
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active) values ($1, $2, 'worker', null, true)`,
      [tx.businessId, actor],
    );
  });
  const items = [await itemFor(w.task, 'decision'), await itemFor(w.task, 'decision')];
  let dispatches = 0;
  const custody: Custody = {
    ...w.custody,
    dispatch: async (credentialRef, request) => {
      dispatches += 1;
      const result = await w.custody.dispatch(credentialRef, request);
      if (dispatches === 1) {
        await w.db.app.withBusiness(w.alpha, async (tx) => {
          await tx.query(
            'update public.actors set active = false, deactivated_at = now() where business_id = $1 and id = $2',
            [tx.businessId, actor],
          );
        });
      }
      return result;
    },
  };
  const timing = { broker: { ...w.broker, custody }, mail: MAIL, preferences };
  const pass = await deliverDue(w.db.app, w.alpha, actor, timing, 'at_once');
  expect(pass).toEqual({ ok: false, code: 'WORKER_REQUIRED' });
  const [inactive] = await w.db.admin.execute<{ active: boolean }>(
    'select active from public.actors where id = $1',
    [actor],
  );
  expect(inactive?.active).toBe(false);
  // The send already with custody ran to its end; the next was never asked.
  const attempted = await Promise.all(items.map(async (item) => await attemptsOf(item)));
  expect(attempted.filter((rows) => rows.length > 0)).toHaveLength(1);
  expect(dispatches).toBe(1);
});

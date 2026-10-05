// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker as the server runs it. `apps/api/server.ts` is
// started as its own OS process with mock mail delivery on, against the email
// world's database and fake provider: a decision waiting in the business it
// recovers goes out through custody without any test calling the worker, and
// SIGTERM ends the process cleanly. The worker's own stop is shown in process.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { mailDeliverySettings, startMailDelivery } from '../../apps/api/mail-delivery.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { sharedKeySetUrl } from '../support/sign-in.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
const ROOT = join(import.meta.dirname, '..', '..');

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

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Polls health until it answers or the process has exited. */
async function answers(port: number, hasExited: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && !hasExited(); attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling one server
    const ok = await fetch(`http://127.0.0.1:${String(port)}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling one server
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return false;
}

interface Served {
  readonly ready: boolean;
  output(): string;
  /** SIGTERM, then the exit code once it has exited. */
  stop(): Promise<number | null>;
}

/** The production entry on a free port, over the world's database, with `settings` added. */
async function serve(settings: Readonly<Record<string, string>>): Promise<Served> {
  const port = await freePort();
  const admin = new URL(databaseUrlFromEnvironment() as string);
  admin.pathname = `/${w.db.name}`;
  const keys = mkdtempSync(join(tmpdir(), 'aw07b-server-keys-'));
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: String(port),
      DATABASE_URL: w.db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      SUPABASE_KEY_SET_URL: await sharedKeySetUrl(),
      GOTRUE_URL: 'http://127.0.0.1:54391',
      GATE_SIGNING_KEY_ID: '',
      GATE_SIGNING_SECRET: '',
      DELEGATION_CREDENTIAL_KEY_FILE: join(keys, 'delegation-keys.json'),
      RECOVERY_BUSINESS_KEYS: 'alpha',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`aw-07b server worker: started apps/api/server.ts pid ${String(child.pid)}`);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  const done = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exited = true;
      resolve(code);
    });
  });
  return {
    ready: await answers(port, () => exited),
    output: () => output,
    stop: async () => {
      if (!exited) child.kill('SIGTERM');
      const code = await done;
      rmSync(keys, { recursive: true, force: true });
      return code;
    },
  };
}

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

const states = async (item: string): Promise<string[]> =>
  (await attemptsOf(item)).map((row) => row.state);

it("AW-07b server worker: a pass for one business never reads or sends another business's mail", async () => {
  const settings = mailDeliverySettings(mockDelivery());
  if (settings.kind !== 'mock') throw new Error(`mail delivery settings: ${settings.kind}`);
  // Bravo has its own active worker and a decision waiting for its own person.
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active) values ($1, $2, 'worker', null, true)`,
      [tx.businessId, randomUUID()],
    );
  });
  const alpha = await itemFor(w.task, 'decision');
  const bravo = await itemFor(w.bravoTask, 'decision', { id: w.bravo, person: w.bravoPerson });
  const deliverFor = async (business: string): Promise<{ readonly stop: () => Promise<void> }> =>
    await startMailDelivery(settings, w.db.app, async () => await Promise.resolve([business]), {
      atOnceMs: 50,
      dailyTickMs: 60_000,
    });
  const before = w.provider.outbox.length;
  const alphaPass = await deliverFor(w.alpha);
  try {
    await expect
      .poll(async () => await states(alpha), { timeout: 10_000 })
      .toEqual(['asked', 'accepted']);
  } finally {
    await alphaPass.stop();
  }
  // Alpha's passes left bravo's item alone and mailed no bravo address.
  expect(await attemptsOf(bravo)).toEqual([]);
  const alphaMail = w.provider.outbox.slice(before);
  expect(alphaMail.length).toBeGreaterThan(0);
  expect(alphaMail.some((message) => message.body.includes('bravo-'))).toBe(false);
  // Served on its own, bravo's item goes, to bravo's person only; alpha's is not sent again.
  const bravoPass = await deliverFor(w.bravo);
  try {
    await expect
      .poll(async () => await states(bravo), { timeout: 10_000 })
      .toEqual(['asked', 'accepted']);
  } finally {
    await bravoPass.stop();
  }
  const bravoMail = w.provider.outbox.slice(before + alphaMail.length);
  expect(bravoMail.length).toBe(1);
  expect(bravoMail[0]?.body.includes(`bravo-${w.canary.split('@')[0] ?? ''}`)).toBe(true);
  expect(await states(alpha)).toEqual(['asked', 'accepted']);
}, 30_000);

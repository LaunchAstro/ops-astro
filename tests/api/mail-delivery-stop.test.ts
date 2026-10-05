// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery as the API starts it, stopped: custody's own process is
// stopped only once the worker's pass already running has ended, so a send in
// flight is never left unknown by its own shutdown. No database: a stand-in
// pool holds the pass, and custody's real process is watched through `fork`.

import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import {
  mailDeliverySettings,
  startMailDelivery,
  type MailDeliverySettings,
} from '../../apps/api/mail-delivery.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const { forked } = vi.hoisted(() => ({ forked: [] as ChildProcess[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>): ChildProcess => {
      const child = actual.fork(...args);
      forked.push(child);
      return child;
    },
  };
});

// Addresses are built from their domains: no address is written whole in the repository.
const SENDING = 'send.example.test';

const folder = mkdtempSync(join(tmpdir(), 'mail-delivery-stop-'));
afterAll(() => {
  for (const child of forked) child.kill('SIGKILL');
  rmSync(folder, { recursive: true, force: true });
});

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise the test resolves by hand. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const untouched = (child: ChildProcess): boolean =>
  !child.killed && child.exitCode === null && child.signalCode === null;

/** Mock delivery over a stand-in key, its provider a closed port on this machine. */
function mockSettings(): Extract<MailDeliverySettings, { kind: 'mock' }> {
  const credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'mail-1', header: 'authorization' };
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      { ref: 'email_key', destination: 'email', ...credential, value: 'stand-in-key-1' },
    ]),
    { mode: 0o600 },
  );
  const settings = mailDeliverySettings({
    MAIL_DELIVERY: 'mock',
    MAIL_PROVIDER_ORIGIN: 'http://127.0.0.1:9',
    MAIL_CREDENTIALS_FILE: credentialsFile,
    MAIL_APP_ORIGIN: 'https://ops.example.test',
    MAIL_FROM: `hello@${SENDING}`,
  });
  if (settings.kind !== 'mock') throw new Error(`mail delivery settings: ${settings.kind}`);
  return settings;
}

it('AW-07b mail delivery: stop stops custody only after the running pass has ended', async () => {
  const settings = mockSettings();

  const pass = barrier();
  const entered: string[] = [];
  let custodyDuringPass: boolean | undefined;
  // The pass reads the business's worker actor; that read is held until released.
  const database = {
    withBusiness: async (businessId: string) => {
      entered.push(businessId);
      await pass.held;
      const [custody] = forked;
      custodyDuringPass = custody !== undefined && untouched(custody);
      return [];
    },
  } as unknown as Database;
  const delivery = await startMailDelivery(
    settings,
    database,
    async () => await Promise.resolve(['first']),
    { atOnceMs: 10, dailyTickMs: 60_000 },
  );
  expect(forked).toHaveLength(1);
  const [custody] = forked;
  if (custody === undefined) throw new Error('custody was not started');
  await expect.poll(() => entered, { timeout: 2_000 }).toEqual(['first']);

  let stopped = false;
  const stopping = (async () => {
    await delivery.stop();
    stopped = true;
  })();
  await delay(200);
  expect(untouched(custody), 'custody stopped under the running pass').toBe(true);
  expect(stopped).toBe(false);

  pass.release();
  await stopping;
  expect(custodyDuringPass).toBe(true);
  expect(custody.exitCode !== null || custody.signalCode !== null).toBe(true);
}, 15_000);

// SPDX-License-Identifier: AGPL-3.0-only
//
// The server's shutdown (`shutDown` in `apps/api/server.ts`) over the real
// mail delivery, in the stages `main` stops (`shutdownStages`, the one list
// `main` hands `shutDown`): the database pool closes only once the mail
// worker's running pass has ended, so a send in flight never loses its pool or
// its custody to the server's own stop. It goes red if the delivery's stop
// stops waiting on the worker (`await worker.stop()` without its await), if
// `shutdownStages` puts the mail worker beside the pools, or if `shutDown`
// starts the pools beside the work. No database: a stand-in pool holds the pass.

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
import { shutDown, shutdownStages } from '../../apps/api/server.ts';
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

const folder = mkdtempSync(join(tmpdir(), 'server-shutdown-'));
afterAll(() => {
  for (const child of forked) child.kill('SIGKILL');
  rmSync(folder, { recursive: true, force: true });
});

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

it("server shutdown: the database closes only after the mail worker's running pass has ended", async () => {
  const settings = mockSettings();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  // The pass reads the business's worker actor; that read is held until released.
  const database = {
    withBusiness: async () => {
      events.push('pass started');
      await held;
      events.push('pass ended');
      return [];
    },
    close: async () => {
      events.push('database closed');
      await Promise.resolve();
    },
  } as unknown as Database;
  const delivery = await startMailDelivery(
    settings,
    database,
    async () => await Promise.resolve(['first']),
    { atOnceMs: 10, dailyTickMs: 60_000 },
  );
  await expect.poll(() => events, { timeout: 2_000 }).toEqual(['pass started']);

  let stopped = false;
  const stopping = (async () => {
    const stages = shutdownStages({
      topics: undefined,
      mail: delivery.stop,
      conversations: undefined,
      database: async () => await database.close(),
      admin: undefined,
      broker: undefined,
      tracer: undefined,
    });
    await shutDown(...stages);
    stopped = true;
  })();
  await delay(300);
  expect(events, 'the database closed under the running pass').toEqual(['pass started']);
  expect(stopped).toBe(false);

  release();
  await stopping;
  expect(events).toEqual(['pass started', 'pass ended', 'database closed']);
}, 15_000);

// SPDX-License-Identifier: AGPL-3.0-only
//
// The server's shutdown (`shutDown` in `apps/api/server.ts`) over the real
// mail delivery, reconciliation sweep and trace export, in the stages `main`
// stops (`shutdownStages`, the one list `main` hands `shutDown`): the database
// pool closes only once each job's running pass has ended, so a send, a sweep
// or an export in flight never loses its pool or its custody to the server's
// own stop. It goes red if a job's stop stops waiting on its running pass, if
// `shutdownStages` puts a job beside the pools, or if `shutDown` starts the
// pools beside the work. No database: a stand-in pool holds the pass.

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
import { startSweeper } from '../../apps/api/recovery-entry.ts';
import { shutDown, shutdownStages, type ServerParts } from '../../apps/api/server.ts';
import { startTraceExporter, traceExportSettings } from '../../apps/api/trace-exporter.ts';
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

const NONE: ServerParts = {
  topics: undefined,
  mail: undefined,
  conversations: undefined,
  sweeper: undefined,
  tracer: undefined,
  database: undefined,
  admin: undefined,
  broker: undefined,
};

/** A promise held until its `release` is called. */
function latch(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

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
      ...NONE,
      mail: delivery.stop,
      database: async () => await database.close(),
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

it("server shutdown: the database closes only after the reconciliation sweep's running pass has ended", async () => {
  const { held, release } = latch();
  const events: string[] = [];
  const sweeper = startSweeper(async () => {
    events.push('pass started');
    await held;
    events.push('pass ended');
    return [];
  }, 10);
  await expect.poll(() => events, { timeout: 2_000 }).toEqual(['pass started']);

  const stopping = shutDown(
    ...shutdownStages({
      ...NONE,
      sweeper: sweeper.stop,
      database: async () => {
        events.push('database closed');
        await Promise.resolve();
      },
    }),
  );
  await delay(300);
  expect(events, 'the database closed under the running sweep').toEqual(['pass started']);

  release();
  await stopping;
  expect(events).toEqual(['pass started', 'pass ended', 'database closed']);
});

it("server shutdown: the trace export's custody and the database stop only after its running export has ended", async () => {
  const credentialsFile = join(folder, 'trace-credentials.json');
  const keyFile = join(folder, 'trace-key');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-1',
        destination: 'trace_target',
        header: 'authorization',
        value: 'stand-in-key-2',
      },
    ]),
    { mode: 0o600 },
  );
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  const settings = traceExportSettings({
    TRACE_EXPORT: 'on',
    TRACE_EXPORT_ORIGIN: 'http://127.0.0.1:9',
    TRACE_EXPORT_CREDENTIALS_FILE: credentialsFile,
    TRACE_EXPORT_KEY_FILE: keyFile,
  });
  if (settings.kind !== 'on') throw new Error(`trace export settings: ${settings.kind}`);
  const { held, release } = latch();
  const events: string[] = [];
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const before = forked.length;
    // The export's first transaction is held until released.
    const database = {
      withBusiness: async () => {
        events.push('export started');
        await held;
        events.push('export ended');
        throw new Error('stand-in pool');
      },
    };
    const tracer = await startTraceExporter(
      settings,
      database,
      async () => await Promise.resolve(['33333333-3333-4333-8333-333333333333']),
      10,
    );
    const custody = forked[before];
    custody?.on('exit', () => events.push('custody stopped'));
    await expect.poll(() => events, { timeout: 2_000 }).toEqual(['export started']);

    const stopping = shutDown(
      ...shutdownStages({
        ...NONE,
        tracer: tracer.stop,
        database: async () => {
          events.push('database closed');
          await Promise.resolve();
        },
      }),
    );
    await delay(300);
    expect(events, 'custody or the database stopped under the running export').toEqual([
      'export started',
    ]);

    release();
    await stopping;
    await expect
      .poll(() => events, { timeout: 2_000 })
      .toEqual(['export started', 'export ended', 'custody stopped', 'database closed']);
  } finally {
    quiet.mockRestore();
  }
}, 15_000);

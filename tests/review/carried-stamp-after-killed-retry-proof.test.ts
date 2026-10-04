// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backupStoreHooks,
  hostReach,
  operatorLogin,
  serverUrl,
} from '../db/backup-identity.fixture.ts';
import {
  carriedBack,
  carriedReceipt,
  drillModule,
  exportedFile,
  gateOf,
  operator,
  scratch,
} from '../db/backup-carried.fixture.ts';

describe.skipIf(serverUrl === undefined)('carried recovery after an interrupted retry', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  it('a retry killed before stamping leaves an accepted receipt recoverable', async () => {
    const receiptFile = carriedBack(await carriedReceipt());
    const archiveFile = exportedFile();
    const { recordCarried } = await drillModule();
    const common = { storeUrl: operatorLogin.url, receiptFile, archiveFile, reach: hostReach };
    const initialGate = gateOf(operator);
    await expect(
      recordCarried({
        ...common,
        gate: {
          ...initialGate,
          recordTestedRestore: () => Promise.reject(new Error('stamp unavailable')),
        },
      }),
    ).rejects.toThrow(/re-run --record/u);
    expect(existsSync(`${receiptFile}.stamp-owed`)).toBe(true);
    const actsModule = pathToFileURL(resolve('scripts/ops/drill-acts.mjs')).href;
    const reachModule = pathToFileURL(resolve('tests/db/backup-host-reach.fixture.ts')).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { recordCarried } from ${JSON.stringify(actsModule)};
      import { hostReach } from ${JSON.stringify(reachModule)};
      const gate = ${JSON.stringify(initialGate)};
      gate.recordSignIn = () => Promise.resolve();
      gate.recordTestedRestore = () => new Promise(() => {process.send('before stamp'); setInterval(() => {},1000);});
      await recordCarried({...JSON.parse(process.env.SOL_RECORD_OPTIONS),gate,reach:hostReach});
    `,
      ],
      {
        env: {
          ...process.env,
          SOL_RECORD_OPTIONS: JSON.stringify({ ...common, reach: undefined }),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const closed = once(child, 'close');
    try {
      await Promise.race([
        once(child, 'message'),
        closed.then(() => {
          throw new Error('retry exited before stamp');
        }),
      ]);
      child.kill('SIGKILL');
      await closed;
      const retry = await Promise.allSettled([
        recordCarried({ ...common, gate: gateOf(operator) }),
      ]);
      expect(
        retry[0]?.status,
        'the note was consumed before the stamp; the store now refuses its accepted receipt as a duplicate',
      ).toBe('fulfilled');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 20_000);
});

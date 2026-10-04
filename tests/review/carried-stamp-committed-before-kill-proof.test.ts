// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- explicit crash between the database effect and acknowledgement */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { recordTestedRestore } from '../../scripts/ops/tested-restore.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';
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

describe.skipIf(serverUrl === undefined)('carried stamp effect acknowledgement', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  it('a carried receipt stamped before interruption cannot stamp again on retry', async () => {
    const installation = await createFreshDatabase({ part: 'd2stamp' });
    const receiptFile = carriedBack(await carriedReceipt());
    const archiveFile = exportedFile();
    const { recordCarried } = await drillModule();
    const common = { storeUrl: operatorLogin.url, receiptFile, archiveFile, reach: hostReach };
    const gate = gateOf(operator);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      await expect(
        recordCarried({
          ...common,
          gate: {
            ...gate,
            recordTestedRestore: () => Promise.reject(new Error('stamp unavailable')),
          },
        }),
      ).rejects.toThrow(/re-run --record/u);
      const acts = pathToFileURL(resolve('scripts/ops/drill-acts.mjs')).href;
      const reach = pathToFileURL(resolve('tests/db/backup-host-reach.fixture.ts')).href;
      const stamps = pathToFileURL(resolve('scripts/ops/tested-restore.ts')).href;
      const url = new URL(process.env['DATABASE_URL'] ?? '');
      url.pathname = `/${installation.name}`;
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { recordCarried } from ${JSON.stringify(acts)};
        import { hostReach } from ${JSON.stringify(reach)};
        import { recordTestedRestore } from ${JSON.stringify(stamps)};
        const gate = JSON.parse(process.env.SOL_STAMP_GATE);
        gate.recordSignIn = async () => {};
        gate.recordTestedRestore = async () => {
          await recordTestedRestore(process.env.SOL_STAMP_DATABASE);
          process.send('database stamp committed');
          return await new Promise(() => { setInterval(() => {}, 1000); });
        };
        await recordCarried({...JSON.parse(process.env.SOL_STAMP_OPTIONS),gate,reach:hostReach});
      `,
        ],
        {
          env: {
            ...process.env,
            SOL_STAMP_DATABASE: url.href,
            SOL_STAMP_GATE: JSON.stringify(gate),
            SOL_STAMP_OPTIONS: JSON.stringify({ ...common, reach: undefined }),
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      child.stderr?.resume();
      closed = once(child, 'close');
      await Promise.race([
        once(child, 'message'),
        closed.then(() => {
          throw new Error('retry exited before committing its stamp');
        }),
      ]);
      const [before] = await installation.admin.execute<{ at: Date }>(
        'select at from ops.last_tested_restore',
      );
      expect(before).toBeDefined();
      child.kill('SIGKILL');
      await closed;
      await recordCarried({
        ...common,
        gate: { ...gate, recordTestedRestore: () => recordTestedRestore(url.href) },
      });
      const [after] = await installation.admin.execute<{ at: Date }>(
        'select at from ops.last_tested_restore',
      );
      expect(
        after?.at.toISOString(),
        'one accepted drill must not re-date its already committed stamp',
      ).toBe(before?.at.toISOString());
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await installation.drop();
    }
  }, 30_000);
});

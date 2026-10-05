// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  retainDeployment,
  startTraceExporter,
  traceExportSettings,
} from '../../apps/api/trace-exporter.ts';
import { derivedId, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { age } from '../runtime/aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from '../runtime/aw-13-world.ts';

const noop = (): void => {};

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

// eslint-disable-next-line max-lines-per-function -- one exporter start around the log capture
it('a trace job error name cannot put a secret in the API log', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-ow004-log-'));
  const credentials = join(folder, 'credentials.json');
  const key = join(folder, 'trace-key');
  writeFileSync(
    credentials,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'proof',
        destination: 'trace_target',
        header: 'authorization',
        value: 'disposable-proof-credential',
      },
    ]),
    { mode: 0o600 },
  );
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  const settings = traceExportSettings({
    TRACE_EXPORT: 'on',
    TRACE_EXPORT_ORIGIN: 'http://127.0.0.1:9',
    TRACE_EXPORT_CREDENTIALS_FILE: credentials,
    TRACE_EXPORT_KEY_FILE: key,
  });
  if (settings.kind !== 'on') throw new Error('proof configuration did not start');
  const canary = 'SOL_OW004_SECRET_IN_ERROR_NAME';
  const cause = new Error('not logged');
  cause.name = canary;
  const lines: string[] = [];
  const logged = latch();
  const capture = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
    logged.resolve();
  });
  let exporter: Awaited<ReturnType<typeof startTraceExporter>> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    exporter = await startTraceExporter(
      settings,
      {
        withBusiness: () => Promise.reject(cause),
      },
      () => Promise.resolve(['11111111-1111-4111-8111-111111111111']),
      10,
    );
    await Promise.race([
      logged.promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('trace tick did not log')), 5000);
      }),
    ]);
    expect(lines.join('\n')).toContain('trace export failed');
    expect(lines.join('\n')).not.toContain(canary);
  } finally {
    if (timeout) clearTimeout(timeout);
    await exporter?.stop();
    capture.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});

useAw13World('sol_ow004_trace');

it.skipIf(noDatabase)(
  'a retention failure in one business does not skip the next business',
  async () => {
    const alpha = await liveWork(t.alpha, 'Sol alpha retention', 1000);
    const bravo = await liveWork(t.bravo, 'Sol bravo retention', 1000);
    await drain(t.alpha);
    await drain(t.bravo);
    await age(String(alpha.picked['runId']), TRACE_WINDOW_DAYS + 1);
    await age(String(bravo.picked['runId']), TRACE_WINDOW_DAYS + 1);
    const bravoTrace = derivedId(
      TRACE_KEY,
      ['trace', t.bravo.business, String(bravo.picked['runId'])],
      32,
    );
    await t.alpha.db.admin
      .execute(`create function public.sol_ow004_retention_fault() returns trigger
    language plpgsql as $$ begin
      if new.business_id = '${t.alpha.business}'::uuid then raise exception 'business-specific retention write failed'; end if;
      return new; end $$`);
    await t.alpha.db.admin
      .execute(`create trigger sol_ow004_retention_fault before insert on public.trace_expiry_batches
    for each row execute function public.sol_ow004_retention_fault()`);
    try {
      await retainDeployment(
        t.alpha.db.app,
        () => Promise.resolve([t.alpha.business, t.bravo.business]),
        TRACE_KEY,
        t.target.expiry,
      ).catch(noop);
      expect(
        t.target.stored.has(bravoTrace),
        'the unaffected business must still receive its retention pass',
      ).toBe(false);
    } finally {
      await t.alpha.db.admin.execute(
        'drop trigger sol_ow004_retention_fault on public.trace_expiry_batches',
      );
      await t.alpha.db.admin.execute('drop function public.sol_ow004_retention_fault()');
    }
  },
);

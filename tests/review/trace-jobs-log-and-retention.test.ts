// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  exportDeployment,
  retainDeployment,
  startTraceExporter,
  traceExportSettings,
} from '../../apps/api/trace-exporter.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from '../runtime/schedules-harness.ts';
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
  'retention cannot delete a fresh event exported after its due-run check',
  // eslint-disable-next-line max-lines-per-function -- one retention held open across a fresh export, read as one case
  async () => {
    const work = await liveWork(t.alpha, 'Sol retention versus new export', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    expect(t.target.stored.has(traceId)).toBe(true);
    const selected = latch();
    const releaseDelete = latch();
    const retention = retainDeployment(
      t.alpha.db.app,
      () => Promise.resolve([t.alpha.business]),
      TRACE_KEY,
      {
        expire: async (ids) => {
          expect(ids).toContain(traceId);
          selected.resolve();
          await releaseDelete.promise;
          return await t.target.expiry.expire(ids);
        },
        present: t.target.expiry.present,
      },
    );
    let freshExport: Promise<void> | undefined;
    let yieldExport: NodeJS.Timeout | undefined;
    const beforeFreshExport = t.target.received.length;
    try {
      await selected.promise;
      const answer = await asAgent(
        t.alpha,
        handbackBody(work.picked),
        String(work.picked['credential']),
      );
      expect(codeOf(answer)).toBe('applied');
      freshExport = exportDeployment(
        t.alpha.db.app,
        () => Promise.resolve([t.alpha.business]),
        TRACE_KEY,
        t.target.deliver,
      );
      // Let an unsynchronised export finish before the delete; a corrected
      // exporter may wait for retention, so release that barrier as well.
      await Promise.race([
        freshExport,
        new Promise<void>((resolve) => {
          yieldExport = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      if (yieldExport) clearTimeout(yieldExport);
      releaseDelete.resolve();
      await Promise.all([retention, freshExport]);
    }
    expect(t.target.received.length).toBeGreaterThan(beforeFreshExport);
    // Give a recovery strategy another tick; the current head's cursor
    // already passed the fresh event, so this does not restore its trace.
    await exportDeployment(
      t.alpha.db.app,
      () => Promise.resolve([t.alpha.business]),
      TRACE_KEY,
      t.target.deliver,
    );
    expect(t.target.stored.has(traceId), 'the fresh exported event must remain retrievable').toBe(
      true,
    );
  },
);

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

it.skipIf(noDatabase)(
  'a run with an event written after its selection is not recorded as expired',
  async () => {
    const work = await liveWork(t.alpha, 'retention versus a late handback', 1000);
    const runId = String(work.picked['runId']);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const batches = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, {
      expire: async (ids) => {
        const answer = await asAgent(
          t.alpha,
          handbackBody(work.picked),
          String(work.picked['credential']),
        );
        expect(codeOf(answer)).toBe('applied');
        return await t.target.expiry.expire(ids);
      },
      present: t.target.expiry.present,
    });
    expect(batches.map((batch) => batch.code)).toContain('expiry_unconfirmed');
    const confirmed = await t.alpha.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.trace_expiry_batches
        where business_id = $1 and $2::uuid = any(expired_run_ids)`,
      [t.alpha.business, runId],
    );
    expect(confirmed).toEqual([{ n: 0 }]);
  },
);

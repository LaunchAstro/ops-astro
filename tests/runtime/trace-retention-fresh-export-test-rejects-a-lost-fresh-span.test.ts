// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it } from 'vitest';
import { exportDeployment, retainDeployment } from '../../apps/api/trace-exporter.ts';
import { derivedId, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import {
  asAgent,
  barrier,
  codeOf,
  handbackBody,
  liveWork,
  type Schedules,
} from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { drain, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('retention_lost_fresh_span');

function latch(): { promise: Promise<void>; resolve: () => void } {
  const gate = barrier();
  return { promise: gate.held, resolve: gate.release };
}

// eslint-disable-next-line max-lines-per-function -- the committed test run unchanged, then what it saw checked
it('the retention regression test must reject a replay that restores only an old span', async () => {
  const source = readFileSync(
    new URL(
      './trace-retention-keeps-an-event-exported-after-its-due-check.test.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const helper = source.slice(
    source.indexOf('async function exportDuringDelete('),
    source.indexOf("useAw13World('"),
  );
  const title = source.indexOf(
    "'retention cannot delete a fresh event exported after its due-run check'",
  );
  const start = source.indexOf('async () => {', title);
  const end = source.indexOf('\n  },\n);', start);
  if (start < 0 || end < 0) throw new Error('the committed regression test was not found');
  const test = source.slice(start, end) + '\n}';
  let oldBody = '';
  const rememberOldSpan = async (s: Schedules): Promise<void> => {
    await drain(s);
    oldBody = t.target.received.at(-1) ?? '';
    expect(spanIds([oldBody])).toHaveLength(1);
  };
  let exports = 0;
  const loseFreshSpan: typeof exportDeployment = async (database, businesses, key, deliver) => {
    exports += 1;
    await exportDeployment(
      database,
      businesses,
      key,
      exports === 1 ? deliver : () => deliver(oldBody),
    );
  };
  // Run the committed helper and test unchanged. The pre-delete export is
  // correct; the recovery export deliberately substitutes the old span.
  const invoke = new Function(
    'retainDeployment',
    't',
    'alphaOnly',
    'TRACE_KEY',
    'latch',
    'expect',
    'asAgent',
    'handbackBody',
    'codeOf',
    'exportDeployment',
    'liveWork',
    'derivedId',
    'drain',
    'age',
    'TRACE_WINDOW_DAYS',
    `${stripTypeScriptTypes(helper)}; return ${stripTypeScriptTypes(test)};`,
  );
  const actualTest: () => Promise<void> = invoke(
    retainDeployment,
    t,
    () => Promise.resolve([t.alpha.business]),
    TRACE_KEY,
    latch,
    expect,
    asAgent,
    handbackBody,
    codeOf,
    loseFreshSpan,
    liveWork,
    derivedId,
    rememberOldSpan,
    age,
    TRACE_WINDOW_DAYS,
  );
  let rejected = false;
  try {
    await actualTest();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AssertionError') throw error;
    rejected = true;
  }
  expect(exports).toBe(2);
  const [fresh] = await t.alpha.db.app.withBusiness(
    t.alpha.business,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        "select id from public.run_events where business_id = $1 and kind = 'handed_back'",
        [tx.businessId],
      ),
  );
  if (!fresh) throw new Error('the fresh event is required');
  const freshSpan = derivedId(TRACE_KEY, ['span', t.alpha.business, fresh.id], 16);
  const deletion = t.target.methods.indexOf('DELETE');
  expect(deletion).toBeGreaterThanOrEqual(0);
  const beforeDelete = t.target.received.filter(
    (_, at) => at < deletion && t.target.methods[at] === 'POST',
  );
  const afterDelete = t.target.received.filter(
    (_, at) => at > deletion && t.target.methods[at] === 'POST',
  );
  expect(spanIds(beforeDelete), 'the fresh span really left before deletion').toContain(freshSpan);
  expect(
    spanIds(afterDelete),
    'the planted recovery defect really loses the fresh span',
  ).not.toContain(freshSpan);
  expect(afterDelete.length).toBeGreaterThan(0);
  expect(t.target.stored.size).toBe(1);
  expect(
    rejected,
    'the committed regression test passed even though only the old span was restored',
  ).toBe(true);
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): two accepted deletes for one run are
// queued at the store. The first lands and retention confirms the run, which
// settles both asks; a fresh handback then exports, and the second delete
// lands after it. The fresh event must stay retrievable, or durable recovery
// must export it again.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import {
  cursorOf,
  drain,
  exportFor,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trret_second_queued_delete');

it.skipIf(noDatabase)(
  'Trace retention: a second queued delete cannot remove a fresh trace after one confirmation',
  async () => {
    // One registered run R, every event exported at C0 and older than the window; no confirmation.
    const work = await liveWork(t.alpha, 'trace retention two queued deletes', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const c0 = await cursorOf(t.alpha);
    expect(t.target.stored.has(traceId)).toBe(true);

    // First pass: the store accepts D1 and queues it; the caller times out.
    let d1: (() => Promise<unknown>) | undefined;
    const first: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceId);
        d1 = async () => await t.target.expiry.expire(ids);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    expect(
      (await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, first)).at(-1),
    ).toMatchObject({ code: 'target_timeout' });
    if (d1 === undefined) throw new Error('D1 was not queued');

    // Second pass, a second ask at C0: D2 queues, D1 lands, the store answers 200 JSON.
    let d2: (() => Promise<unknown>) | undefined;
    const second: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceId);
        d2 = async () => await t.target.expiry.expire(ids);
        await d1?.();
        return { ok: true, status: 200, body: '{}' };
      },
      present: t.target.expiry.present,
    };
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, second);
    if (d2 === undefined) throw new Error('D2 was not queued');
    expect(await cursorOf(t.alpha)).toBe(c0);

    // A fresh handback to R exports to C1.
    const answer = await asAgent(t.alpha, handbackBody(work.picked), String(work.picked['credential']));
    expect(codeOf(answer)).toBe('applied');
    await drain(t.alpha);
    expect(await cursorOf(t.alpha)).not.toBe(c0);
    expect(t.target.stored.has(traceId)).toBe(true);

    // D2 lands.
    await d2();

    // Export, retention, export, the fresh event still inside the window.
    await exportFor(t.alpha);
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
    await exportFor(t.alpha);
    expect(
      t.target.stored.has(traceId),
      'the fresh handback must remain retrievable or be exported again after D2 lands',
    ).toBe(true);
  },
);

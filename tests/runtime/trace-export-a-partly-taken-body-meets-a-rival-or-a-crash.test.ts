// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export: a body the target took in part (OTLP `partialSuccess`) is a
// gap on record and the cursor moves past it. Around that step: a rival
// export, on its own connection, started while the first waits on the
// target's partial reply is held and sends nothing, and once the gap is on
// record nothing is sent again. An exporter that dies after the partial reply
// and before its record writes nothing: the batch stays where it was, the
// business stays held until the lease runs out, and then the batch goes once
// more and is recorded as one gap.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { exportOnce } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import {
  ageLease,
  awaitDue,
  cursorOf,
  drain,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trexp_partial_race');

const PARTIAL = JSON.stringify({
  partialSuccess: { rejectedSpans: '1', errorMessage: 'span rejected' },
});
const partly = async () => await Promise.resolve({ ok: true, status: 200, body: PARTIAL } as const);

const gapsOf = async (): Promise<readonly string[]> =>
  (
    await rows<{ code: string }>(
      t.alpha,
      'select code from public.trace_export_gaps where business_id = $1 order by recorded_at',
      [t.alpha.business],
    )
  ).map((row) => row.code);

it.skipIf(noDatabase)(
  'Trace export: a rival started while a body is partly taken is held, and nothing is sent again after the gap',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export partial rival', 1_000);
    await awaitDue(s);
    const before = (await gapsOf()).length;
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    const rivalSent: string[] = [];
    const sendRival = async (body: string) => {
      rivalSent.push(body);
      return await t.target.deliver(body);
    };
    try {
      let rivalOutcome: unknown;
      const first = await exportOnce(s.db.app, s.business, TRACE_KEY, async () => {
        rivalOutcome = await exportOnce(rival, s.business, TRACE_KEY, sendRival);
        return await partly();
      });
      expect(rivalOutcome).toEqual({ kind: 'held' });
      expect(first).toMatchObject({ kind: 'gap', code: 'target_refused' });
      expect((await gapsOf()).slice(before)).toEqual(['target_refused']);
      expect(await exportOnce(rival, s.business, TRACE_KEY, sendRival)).toEqual({ kind: 'idle' });
      expect(rivalSent).toEqual([]);
    } finally {
      await rival.close();
    }
  },
);

it.skipIf(noDatabase)(
  'Trace export: an exporter that dies after a partly taken body, before its record, leaves the batch held to its lease, then sent once more as one gap',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export partial crash', 1_000);
    await awaitDue(s);
    const before = (await gapsOf()).length;
    const at = await cursorOf(s);
    let calls = 0;
    // The read, the lease renewal before the body, then the record: it dies there.
    const dying: TraceDatabase = {
      withBusiness: async (businessId, run) => {
        calls += 1;
        if (calls === 3) throw new Error('the exporter died');
        return await s.db.app.withBusiness(businessId, run);
      },
    };
    await expect(exportOnce(dying, s.business, TRACE_KEY, partly)).rejects.toThrow('died');
    expect(await gapsOf()).toHaveLength(before);
    expect(await cursorOf(s)).toBe(at);

    const sent: string[] = [];
    const sendPartly = async (body: string) => {
      sent.push(body);
      return await partly();
    };
    expect(await exportOnce(s.db.app, s.business, TRACE_KEY, sendPartly)).toEqual({
      kind: 'held',
    });
    expect(sent).toEqual([]);
    await ageLease(s);
    expect(await exportOnce(s.db.app, s.business, TRACE_KEY, sendPartly)).toMatchObject({
      kind: 'gap',
      code: 'target_refused',
    });
    expect(sent).toHaveLength(1);
    expect((await gapsOf()).slice(before)).toEqual(['target_refused']);
    expect(await cursorOf(s)).not.toBe(at);
    expect(await exportOnce(s.db.app, s.business, TRACE_KEY, sendPartly)).toEqual({
      kind: 'idle',
    });
    expect(sent).toHaveLength(1);
  },
);

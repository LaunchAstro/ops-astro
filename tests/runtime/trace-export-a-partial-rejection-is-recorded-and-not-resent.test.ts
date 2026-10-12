// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export: an OTLP target may answer 200 with `partialSuccess`, naming
// spans it rejected. That is no full delivery. The export says so and keeps a
// gap for the batch, and since OTLP forbids sending a partly accepted request
// again, the cursor moves past it: the next export does not resend it.

import { expect, it } from 'vitest';
import { exportOnce } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_partial');

const PARTIAL = JSON.stringify({
  partialSuccess: { rejectedSpans: '1', errorMessage: 'span rejected' },
});

it.skipIf(noDatabase)(
  'Trace export: a partly rejected body is a gap on record, and the next export does not send it again',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export partial rejection', 1_000);
    await awaitDue(s);
    const gaps = async () =>
      await rows<{ code: string }>(
        s,
        'select code from public.trace_export_gaps where business_id = $1',
        [s.business],
      );
    const before = (await gaps()).length;

    expect(
      await exportOnce(s.db.app, s.business, TRACE_KEY, async () => {
        return await Promise.resolve({ ok: true, status: 200, body: PARTIAL } as const);
      }),
    ).toMatchObject({ kind: 'gap', code: 'target_refused' });
    expect((await gaps()).slice(before)).toEqual([{ code: 'target_refused' }]);

    const sent: string[] = [];
    expect(
      await exportOnce(s.db.app, s.business, TRACE_KEY, async (body) => {
        sent.push(body);
        return await t.target.deliver(body);
      }),
    ).toEqual({ kind: 'idle' });
    expect(sent).toEqual([]);
  },
);

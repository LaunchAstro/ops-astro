// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963): a body the target timed out on may still be stored
// later, after another export has moved on and a queued delete has landed.
// So a gap whose body may have landed keeps the business for the lease's
// length: the next export, on its own connection, is held. A gap whose body
// was refused stored nothing, and the next export goes at once.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { exportOnce } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import {
  ageLease,
  awaitDue,
  drain,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trexp_unsure_gap');

it.skipIf(noDatabase)(
  'Trace export: after a gap whose body may have landed, the next export waits out the lease; after a refusal it does not',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export unsure gap', 1_000);
    await awaitDue(s);
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    try {
      expect(
        await exportOnce(s.db.app, s.business, TRACE_KEY, async () =>
          Promise.resolve({ ok: false, fault: 'timeout', status: null }),
        ),
      ).toMatchObject({ kind: 'gap', code: 'target_timeout' });
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
        'a timed-out body may still be stored: the next export waits',
      ).toEqual({ kind: 'held' });

      await ageLease(s);
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, async () =>
          Promise.resolve({ ok: false, fault: 'status', status: 503 }),
        ),
      ).toMatchObject({ kind: 'gap', code: 'target_refused' });
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
        'a refused body stored nothing: the next export goes at once',
      ).toMatchObject({ kind: 'delivered' });
    } finally {
      await rival.close();
    }
  },
);

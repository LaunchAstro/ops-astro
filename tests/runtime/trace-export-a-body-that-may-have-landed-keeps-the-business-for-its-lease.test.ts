// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963): a body the target timed out on, lost the connection
// over, or answered with a reply too large or not JSON may still be stored
// later, after another export has moved on and a queued delete has landed.
// So such a gap keeps the business for the lease's length: the next export,
// on its own connection, is held, even when a retention step gave the
// cursor row a new version while the body was out. A gap whose answer says
// the target took nothing (a refusal, a redirect, custody's own refusal, a
// 413) gives the lease up, and the next export goes at once.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Delivered } from '../../packages/core-runtime/src/index.ts';
import { exportOnce } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
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

const answer =
  (delivered: Delivered): (() => Promise<Delivered>) =>
  async () =>
    await Promise.resolve(delivered);

const MAYBE_STORED: readonly (readonly [string, Delivered])[] = [
  ['target_timeout', { ok: false, fault: 'timeout', status: null }],
  ['target_unreachable', { ok: false, fault: 'network', status: null }],
  ['target_oversized_reply', { ok: false, fault: 'too_large', status: 200 }],
  ['target_malformed_reply', { ok: true, status: 200, body: 'x' }],
];

const STORED_NOTHING: readonly (readonly [string, Delivered])[] = [
  ['target_refused', { ok: false, fault: 'status', status: 503 }],
  ['target_redirect', { ok: false, fault: 'redirect', status: 302 }],
  ['target_forbidden', { ok: false, fault: 'forbidden', status: null }],
  ['target_oversized_body', { ok: false, fault: 'status', status: 413 }],
];

it.skipIf(noDatabase)(
  'Trace export: after a gap whose body may have landed, the next export waits out the lease; after one that took nothing it does not',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export unsure gap', 1_000);
    await awaitDue(s);
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    try {
      for (const [code, delivered] of MAYBE_STORED) {
        // eslint-disable-next-line no-await-in-loop -- one answer after another
        expect(await exportOnce(s.db.app, s.business, TRACE_KEY, answer(delivered))).toMatchObject(
          { kind: 'gap', code },
        );
        expect(
          // eslint-disable-next-line no-await-in-loop -- one answer after another
          await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
          `${code}: the body may still be stored, so the next export waits`,
        ).toEqual({ kind: 'held' });
        // eslint-disable-next-line no-await-in-loop -- the lease runs out
        await ageLease(s);
      }
      for (const [code, delivered] of STORED_NOTHING) {
        // eslint-disable-next-line no-await-in-loop -- one answer after another
        expect(await exportOnce(s.db.app, s.business, TRACE_KEY, answer(delivered))).toMatchObject(
          { kind: 'gap', code },
        );
        expect(
          // eslint-disable-next-line no-await-in-loop -- one answer after another
          await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
          `${code}: the target took nothing, so the next export goes at once`,
        ).toMatchObject({ kind: 'delivered' });
        // eslint-disable-next-line no-await-in-loop -- a fresh event for the next answer
        await liveWork(s, `trace export after ${code}`, 1_000);
        // eslint-disable-next-line no-await-in-loop -- until it is due
        await awaitDue(s);
      }
    } finally {
      await rival.close();
    }
  },
);

it.skipIf(noDatabase)(
  'Trace export: a body that may have landed keeps the lease even when retention stepped the cursor meanwhile',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export unsure gap after a step', 1_000);
    await awaitDue(s);
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    try {
      // While the body is out, a retention step gives the row a new version.
      expect(
        await exportOnce(s.db.app, s.business, TRACE_KEY, async () => {
          await rows(
            s,
            'update public.trace_export_cursors set updated_at = now() where business_id = $1',
            [s.business],
          );
          return { ok: false, fault: 'timeout', status: null };
        }),
      ).toMatchObject({ kind: 'gap', code: 'target_timeout' });
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
        'the timed-out body may still be stored, so the next export waits',
      ).toEqual({ kind: 'held' });
    } finally {
      await rival.close();
    }
  },
);

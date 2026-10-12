// SPDX-License-Identifier: AGPL-3.0-only
//
// A staging reset carries the sessions ended installation-wide across the
// emptying and puts them back once migrated. Each ending keeps the time it
// had: put back at the reset's own time, it would end every session its
// subject signed in before the reset, those signed in after the ending too.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

const ENDED_BEFORE = '2026-01-02T03:04:05.000Z';

it.skipIf(serverUrl === undefined)(
  'staging reset puts each carried subject-session ending back with the time it had',
  async () => {
    const first = await run(settings());
    expect(first.status, `precondition: the first reset finishes\n${first.out}`).toBe(0);

    const digest = randomBytes(32).toString('hex');
    await onDatabase(async (admin) => {
      await admin.execute(
        'insert into ops.ended_subject_sessions (subject_digest, kept_session) values ($1, null)',
        [digest],
      );
      // An ending made before the reset, at a time well before it.
      await admin.execute(
        'update ops.ended_subject_sessions set ended_before = $2 where subject_digest = $1',
        [digest, ENDED_BEFORE],
      );
    });

    const again = await run(settings());
    expect(again.status, `the second reset finishes\n${again.out}`).toBe(0);

    const kept = await onDatabase(
      async (admin) =>
        await admin.execute<{ ended_before: Date }>(
          'select ended_before from ops.ended_subject_sessions where subject_digest = $1',
          [digest],
        ),
    );
    expect(kept.map((row) => new Date(row.ended_before).toISOString())).toEqual([ENDED_BEFORE]);
  },
  360_000,
);

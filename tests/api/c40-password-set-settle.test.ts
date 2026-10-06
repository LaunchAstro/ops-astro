// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset slower than its window's bound (C40, five minutes) settles a window
// that by then ends no session signed in after `open_until`; the settle ends
// them. A write in another business that read such a session live, its ending
// keys held (C52-A's last read, `sessionEndedHeld`), commits before that
// settle does (security re-bind P11a-MAININ2 LOW-1, the PRV-oa-984-R2.1 class).
// Real Postgres, API and custody.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  connect,
  type Database,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import {
  sessionEnded,
  sessionEndedHeld,
} from '../../packages/core-records/src/identity/sessions.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  answerWith,
  freshMember,
  inBravoToo,
  mintToken,
  now,
  setPassword,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';
import { json } from './c58-sessions-world.ts';

usePasswordWorld();

function gate() {
  const settle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, open: () => settle.resolve?.() };
}

/** Whether the settle waits on a lock before `finished`, polled on its own connection. */
async function waitsBeforeFinished(finished: () => boolean): Promise<boolean> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${world.db.name}`;
  const observer = connectAsAdmin(url.toString());
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !finished()) {
      // oxlint-disable-next-line no-await-in-loop -- observe the real lock before polling again
      const [row] = await observer.execute<{ waiting: boolean }>(
        `select exists (select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock') as waiting`,
      );
      if (row?.waiting === true) return true;
      // oxlint-disable-next-line no-await-in-loop -- the next poll follows this delay
      await delay(20);
    }
    return false;
  } finally {
    await observer.close();
  }
}

/**
 * The provider's stand-in for one reset that ran past its window's bound: it
 * moves `open_until` ten seconds behind now, then holds a `sessionEndedHeld`
 * read in bravo on `own` (a connection of its own: on the route's pool the
 * reset's next transaction would wait for a connection, not a lock) and
 * answers once that read is in. The read commits on `release`.
 */
function heldWhileAnswering(own: Database, presented: VerifiedSubject) {
  const read = gate();
  const release = gate();
  let holder: Promise<boolean> | undefined;
  answerWith((request, response) => {
    void (async () => {
      await world.db.admin.transaction(async (query) => {
        await query('set local session_replication_role = replica', []);
        await query(
          `update ops.subject_resets set open_until = clock_timestamp() - interval '10 seconds'
            where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
              and settled_at is null`,
          [presented.subject],
        );
      });
      holder = own.withBusiness(world.bravo, async (tx) => {
        const ended = await sessionEndedHeld(tx, presented);
        read.open();
        await release.promise;
        return ended;
      });
      await read.promise;
      const id = (request.url ?? '').split('/').at(-1) ?? '';
      json(200, { id, email: 'x@example.test', aud: 'authenticated' })(request, response);
    })();
  });
  return { release: release.open, ended: async () => await holder };
}

it.skipIf(serverUrl === undefined)(
  "a reset settled past its window's bound waits for a write that read the login's session live",
  async () => {
    const member = await freshMember('settle-held-read');
    const subject = member.presented.subject;
    await inBravoToo(subject, 'settle-held-read-bravo');
    const token = await mintToken(subject);
    // Signed in after the bound the window is moved to, before the settle.
    const presented = {
      provider: 'supabase' as const,
      subject,
      sessionId: randomUUID(),
      assurance: { level: 'aal1' as const, signedInAt: now() - 5, factorAt: null },
    };
    const own = connect(world.db.appUrl, { source: 'runtime', max: 1 });
    const held = heldWhileAnswering(own, presented);
    let finished = false;
    const pending = setPassword(token, 'a reset slower than its bound').finally(() => {
      finished = true;
    });
    let waited = false;
    try {
      waited = await waitsBeforeFinished(() => finished);
    } finally {
      held.release();
    }
    const liveWhenRead = !(await held.ended());
    await own.close();
    const answer = await pending;
    const endedAfter = await world.db.app.withBusiness(
      world.bravo,
      async (tx) => await sessionEnded(tx, presented),
    );
    expect({ waited, liveWhenRead, status: answer.status, endedAfter }).toStrictEqual({
      waited: true,
      liveWhenRead: true,
      status: 200,
      endedAfter: true,
    });
  },
  60_000,
);

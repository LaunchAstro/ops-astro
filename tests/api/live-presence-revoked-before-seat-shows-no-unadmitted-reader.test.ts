// SPDX-License-Identifier: AGPL-3.0-only
//
// Person to person: the door admits A, then A's read grant on the task is
// revoked before the stream's seat is looked up; A's login is unchanged. A
// stream sits only once a recheck has admitted the person who sits: while A's
// refused recheck is still in flight, an observer on the task never sees A's
// name or id.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connect, connectListener } from '../../packages/core-records/src/index.ts';
import {
  admitReads,
  executeRead,
  isCommandRefusal,
  viewerOf,
} from '../../packages/core-commands/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { testSignIn } from '../support/sign-in.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';
import { authorised, tokenFor, ISSUER } from './fixture.ts';
import { join, topic, within, type Joined } from './c4-live-support.ts';

it('a reader whose grant is revoked between its door admission and its seat is never shown on the task', async () => {
  const s = await openSchedules('revokedbeforeseat', 100_000);
  const pool = connect(s.db.appUrl, { max: 4 });
  const topics = await startLiveTopics(connectListener(s.db.appUrl));
  const presence = createLivePresence();
  const ids = { subject: '', first: '', grant: '', task: '' };
  let phase: 'idle' | 'armed' | 'revoked' = 'idle';
  let deniedCheckHeld = false;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = composeApi({
    database: pool,
    admin: s.db.admin,
    signIn: testSignIn(ISSUER),
    keys: runtimeKeys({ ...process.env }),
    executeRead,
    live: {
      topics,
      recheckMs: 60_000,
      presence,
      admit: async (...args) => {
        const admitted = await admitReads(...args);
        // Hold only the stream's own refused recheck once A's grant is gone;
        // its real database answer is kept and returned when released.
        const denied =
          !isCommandRefusal(admitted) &&
          admitted.some(
            (answer) => isCommandRefusal(answer) && answer.code === 'SCOPE_NOT_GRANTED',
          );
        if (
          phase === 'revoked' &&
          denied &&
          args[4] === 'recheck' &&
          args[2].subject === ids.subject
        ) {
          deniedCheckHeld = true;
          await gate;
        }
        return admitted;
      },
      viewer: async (...args) => {
        if (phase === 'armed' && args[2].subject === ids.subject) {
          // The door admitted A; A's grant is revoked before the seat is looked up.
          phase = 'revoked';
          await s.db.app.withBusiness(s.business, async (tx) => {
            expect(await revokeGrant(tx, ids.grant)).not.toBeNull();
          });
        }
        return await viewerOf(...args);
      },
    },
  }).app;
  const opened: Joined[] = [];
  try {
    ids.task = await createTask(s, 'Only A may read this task');
    const firstName = `first-${randomUUID()}`;
    const first = await enrol(s.db.app, s.business, firstName);
    ids.subject = first.presented.subject;
    ids.first = first.personId;
    ids.grant = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, first, 'read', { kind: 'record', id: ids.task }),
    );
    const [row] = await s.db.admin.execute<{ key: string }>(
      'select key from public.businesses where id = $1',
      [s.business],
    );
    const key = row!.key;
    const observerToken = await tokenFor(s.decider.presented.subject);
    const observer = await join(api, key, [topic(ids.task)], observerToken);
    opened.push(observer);
    expect(observer.status).toBe(200);
    await within(2_000, () => observer.heard.some((frame) => frame.event === 'seat'), 'a seat');
    const observerSeat = observer.heard.find((frame) => frame.event === 'seat')!.data;

    phase = 'armed';
    const revoked = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(revoked);
    expect(revoked.status, 'the door admitted A').toBe(200);
    await within(
      2_000,
      () => phase === 'revoked' && revoked.heard.some((frame) => frame.event === 'resync'),
      "A's grant was revoked before the seat lookup, and the stream followed the task",
    );
    await pool.withBusiness(s.business, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [ids.task]);
    });
    await within(2_000, () => deniedCheckHeld, "A's refused recheck is in flight");

    const refused = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(refused);
    expect(refused.status, 'A no longer holds a grant on the task').toBe(403);
    expect(refused.refusal).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });

    const shown = await api.request(
      `${PREFIX.person}${key}/live/presence?seat=${observerSeat}&topic=${topic(ids.task)}`,
      { headers: authorised(observerToken) },
    );
    expect(shown.status).toBe(200);
    const body = await shown.text();
    expect(body, "A's id reached an observer on a task A can no longer read").not.toContain(
      ids.first,
    );
    expect(body, "A's name reached an observer on a task A can no longer read").not.toContain(
      firstName,
    );
  } finally {
    release();
    await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
    await topics.close();
    await pool.close();
    await s.db.drop();
  }
});

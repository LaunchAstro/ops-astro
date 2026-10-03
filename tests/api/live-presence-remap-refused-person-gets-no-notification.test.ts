// SPDX-License-Identifier: AGPL-3.0-only
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
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';
import { authorised, tokenFor, ISSUER } from './fixture.ts';
import { join, topic, within, type Joined } from './c4-live-support.ts';

// Person to person: the task's recheck passes for the person with the grant,
// then the login moves to a person without it before the stream asks who
// sits. That pass must not seat the new person; the task asks again for them
// first (held here, and refused).
it('person to person remapping emits no task notification for a person the task refuses', async () => {
  const s = await openSchedules('solfixremapsignal', 100_000);
  const pool = connect(s.db.appUrl, { max: 4 });
  const topics = await startLiveTopics(connectListener(s.db.appUrl));
  const presence = createLivePresence();
  const ids = { subject: '', first: '', second: '', task: '' };
  let phase: 'idle' | 'armed' | 'passed' | 'remapped' = 'idle';
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
        const own =
          args[4] === 'recheck' &&
          args[2].subject === ids.subject &&
          args[3].some((request) => 'recordId' in request && request['recordId'] === ids.task);
        if (own && phase === 'armed') phase = 'passed';
        else if (
          own &&
          phase === 'remapped' &&
          !isCommandRefusal(admitted) &&
          admitted.some((answer) => isCommandRefusal(answer))
        ) {
          deniedCheckHeld = true;
          await gate;
        }
        return admitted;
      },
      viewer: async (...args) => {
        if (phase === 'passed' && args[2].subject === ids.subject) {
          // The recheck passed for the first person; the login moves before the stream asks who sits.
          phase = 'remapped';
          await s.db.admin.execute(
            'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
            [s.business, ids.second, ids.first],
          );
        }
        return await viewerOf(...args);
      },
    },
  }).app;
  const opened: Joined[] = [];
  try {
    ids.task = await createTask(s, 'Only the first person may read this task');
    const first = await enrol(s.db.app, s.business, `first-${randomUUID()}`);
    const second = await enrol(s.db.app, s.business, `second-${randomUUID()}`);
    ids.subject = first.presented.subject;
    ids.first = first.personId;
    ids.second = second.personId;
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, first, 'read', { kind: 'record', id: ids.task });
    });
    const [row] = await s.db.admin.execute<{ key: string }>(
      'select key from public.businesses where id = $1',
      [s.business],
    );
    const key = row!.key;
    const observerToken = await tokenFor(s.decider.presented.subject);
    const observer = await join(api, key, [topic(ids.task)], observerToken);
    const remapped = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(observer, remapped);
    expect([observer.status, remapped.status]).toEqual([200, 200]);
    await within(
      2_000,
      () => opened.every((tab) => tab.heard.some((frame) => frame.event === 'seat')),
      'both seats',
    );
    await within(
      2_000,
      () => remapped.heard.some((frame) => frame.event === 'presence'),
      'initial presence recheck completed',
    );
    expect(remapped.heard.filter((frame) => frame.event === 'invalidate')).toEqual([]);
    const observerSeat = observer.heard.find((frame) => frame.event === 'seat')!.data;
    phase = 'armed';
    await pool.withBusiness(s.business, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [ids.task]);
    });
    // Held only once the passed recheck has been followed by the new person's refused one.
    await within(2_000, () => deniedCheckHeld, 'the task asks again for the new person');
    const refused = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(refused);
    expect(refused.status, 'the person receiving the notification cannot join this task').toBe(403);
    expect(refused.refusal).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    const shown = await api.request(
      `${PREFIX.person}${key}/live/presence?seat=${observerSeat}&topic=${topic(ids.task)}`,
      { headers: authorised(observerToken) },
    );
    expect(shown.status).toBe(200);
    const visible = (await shown.json()) as { seenBy: { personId: string }[] };
    expect(
      visible.seenBy,
      'the new person was seated off the previous person recheck',
    ).not.toContainEqual(expect.objectContaining({ personId: second.personId }));
    expect(
      remapped.heard.filter((frame) => frame.event === 'invalidate'),
      'the remapped person was refused the task but received its change notification',
    ).toEqual([]);
  } finally {
    release();
    await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
    await topics.close();
    await pool.close();
    await s.db.drop();
  }
});

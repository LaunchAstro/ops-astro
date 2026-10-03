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
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { testSignIn } from '../support/sign-in.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';
import { authorised, tokenFor, ISSUER } from './fixture.ts';
import { join, topic, within, type Joined } from './c4-live-support.ts';

it('person to person remapping at the door cannot seat a person on a task they cannot read', async () => {
  const s = await openSchedules('soldoorremap', 100_000);
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
      presence,
      recheckMs: 60_000,
      admit: async (...args) => {
        const admitted = await admitReads(...args);
        if (args[2].subject === ids.subject && phase === 'armed' && args[4] === 'door') {
          expect(isCommandRefusal(admitted)).toBe(false);
          if (!isCommandRefusal(admitted))
            expect(admitted.some((answer) => isCommandRefusal(answer))).toBe(false);
          phase = 'passed';
        } else if (
          args[2].subject === ids.subject &&
          phase === 'remapped' &&
          args[4] === 'recheck'
        ) {
          expect(isCommandRefusal(admitted)).toBe(false);
          if (!isCommandRefusal(admitted))
            expect(admitted).toContainEqual(expect.objectContaining({ code: 'SCOPE_NOT_GRANTED' }));
          deniedCheckHeld = true;
          await gate;
        }
        return admitted;
      },
      viewer: async (...args) => {
        if (args[2].subject === ids.subject && phase === 'passed') {
          await s.db.admin.execute(
            'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
            [s.business, ids.second, ids.first],
          );
          phase = 'remapped';
        }
        return await viewerOf(...args);
      },
    },
  }).app;
  const opened: Joined[] = [];
  try {
    ids.task = await createTask(s, 'Only the person admitted at the door has a grant');
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
    opened.push(observer);
    expect(observer.status).toBe(200);
    await within(
      2_000,
      () => observer.heard.some((frame) => frame.event === 'seat'),
      'observer seated',
    );
    const observerSeat = observer.heard.find((frame) => frame.event === 'seat')!.data;
    phase = 'armed';
    const remapped = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(remapped);
    expect(remapped.status).toBe(200);
    await within(2_000, () => deniedCheckHeld, 'replacement person real denied recheck held');
    const refused = await join(api, key, [topic(ids.task)], await tokenFor(ids.subject));
    opened.push(refused);
    expect(refused.status).toBe(403);
    expect(refused.refusal).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    const response = await api.request(
      `${PREFIX.person}${key}/live/presence?seat=${observerSeat}&topic=${topic(ids.task)}`,
      { headers: authorised(observerToken) },
    );
    expect(response.status).toBe(200);
    const visible = (await response.json()) as { seenBy: { personId: string }[] };
    expect(
      visible.seenBy,
      'the door admitted A but the API exposes ungranted B on this task before B is admitted',
    ).not.toContainEqual(expect.objectContaining({ personId: ids.second }));
  } finally {
    release();
    await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
    await topics.close();
    await pool.close();
    await s.db.drop();
  }
});

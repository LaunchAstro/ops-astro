// SPDX-License-Identifier: AGPL-3.0-only
//
// Person to person: A's tab holds a seat on a task both A and B may read. A
// mark from A's tab resolves A, then the login is remapped to B before the
// task is asked about again, so the recheck admits B. The route acts for the
// person the recheck admitted or not at all: it never marks A's seat on a
// request whose login now resolves to B.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connect, connectListener } from '../../packages/core-records/src/index.ts';
import { admitReads, executeRead, viewerOf } from '../../packages/core-commands/src/index.ts';
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

it('a mark whose login moves to another reader before its recheck marks nothing', async () => {
  const s = await openSchedules('remapbeforemark', 100_000);
  const pool = connect(s.db.appUrl, { max: 4 });
  const topics = await startLiveTopics(connectListener(s.db.appUrl));
  const presence = createLivePresence();
  const ids = { subject: '', first: '', second: '', task: '' };
  let phase: 'idle' | 'armed' | 'remapped' = 'idle';
  let admittedOnRecheck: string | undefined;
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
        if (phase === 'remapped' && args[4] === 'recheck' && args[2].subject === ids.subject) {
          const [answer] = Array.isArray(admitted) ? admitted : [];
          admittedOnRecheck ??= answer !== undefined && 'personId' in answer ? answer.personId : '';
        }
        return admitted;
      },
      viewer: async (...args) => {
        const viewer = await viewerOf(...args);
        if (phase === 'armed' && args[2].subject === ids.subject) {
          // The mark resolved A; the login moves to B before the task is asked about again.
          phase = 'remapped';
          await s.db.admin.execute(
            'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
            [s.business, ids.second, ids.first],
          );
        }
        return viewer;
      },
    },
  }).app;
  const opened: Joined[] = [];
  try {
    ids.task = await createTask(s, 'A and B may both read this task');
    const first = await enrol(s.db.app, s.business, `first-${randomUUID()}`);
    const second = await enrol(s.db.app, s.business, `second-${randomUUID()}`);
    ids.subject = first.presented.subject;
    ids.first = first.personId;
    ids.second = second.personId;
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, first, 'read', { kind: 'record', id: ids.task });
      await grantTo(tx, second, 'read', { kind: 'record', id: ids.task });
    });
    const [row] = await s.db.admin.execute<{ key: string }>(
      'select key from public.businesses where id = $1',
      [s.business],
    );
    const key = row!.key;
    const token = await tokenFor(ids.subject);
    const tab = await join(api, key, [topic(ids.task)], token);
    opened.push(tab);
    expect(tab.status, 'A may read the task').toBe(200);
    await within(2_000, () => tab.heard.some((frame) => frame.event === 'seat'), "A's seat");
    const seat = tab.heard.find((frame) => frame.event === 'seat')!.data;

    phase = 'armed';
    const marked = await fetchMark(api, key, token, {
      seat,
      topic: topic(ids.task),
      field: 'title',
    });
    expect(phase, 'the login moved between the viewer and the recheck').toBe('remapped');
    expect(admittedOnRecheck, 'the recheck admitted B, who may read the task').toBe(ids.second);
    expect(marked.body, "A's seat was marked on a request whose login is B's").not.toHaveProperty(
      'marked',
    );
    expect(marked.status).not.toBe(200);
  } finally {
    await Promise.allSettled(opened.map(async (each) => await each.stop()));
    await topics.close();
    await pool.close();
    await s.db.drop();
  }
});

async function fetchMark(
  api: { fetch: (request: Request) => Response | Promise<Response> },
  key: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.person}${key}/live/mark`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { ...authorised(token), 'content-type': 'application/json' },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

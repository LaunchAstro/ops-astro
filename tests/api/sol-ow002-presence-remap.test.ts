// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connect, connectListener } from '../../packages/core-records/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';
import { authorised, tokenFor } from './fixture.ts';
import { join, liveApi, topic, within, type Joined } from './c4-live-support.ts';

it('Sol proof, criterion 2: person to person presence cannot retain the previous person after a login remaps', async () => {
  const s = await openSchedules('solow002presence', 100_000);
  const pool = connect(s.db.appUrl, { max: 4 });
  const topics = await startLiveTopics(connectListener(s.db.appUrl));
  const presence = createLivePresence();
  const api = liveApi(s, pool, topics, () => {}, presence);
  const opened: Joined[] = [];
  try {
    const taskId = await createTask(s, 'Remapped presence');
    const first = await enrol(s.db.app, s.business, `first-${randomUUID()}`);
    const second = await enrol(s.db.app, s.business, `second-${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, first, 'read', { kind: 'record', id: taskId });
      await grantTo(tx, second, 'read', { kind: 'record', id: taskId });
    });
    const [row] = await s.db.admin.execute<{ key: string }>(
      'select key from public.businesses where id = $1',
      [s.business],
    );
    const key = row!.key;
    const observerToken = await tokenFor(s.decider.presented.subject);
    const oldToken = await tokenFor(first.presented.subject);
    const observer = await join(api, key, [topic(taskId)], observerToken);
    const remapped = await join(api, key, [topic(taskId)], oldToken);
    opened.push(observer, remapped);
    expect([observer.status, remapped.status]).toEqual([200, 200]);
    await within(
      2_000,
      () => opened.every((tab) => tab.heard.some((frame) => frame.event === 'seat')),
      'both seats',
    );
    const observerSeat = observer.heard.find((frame) => frame.event === 'seat')!.data;
    const oldSeat = remapped.heard.find((frame) => frame.event === 'seat')!.data;
    const marked = await api.request(`${PREFIX.person}${key}/live/mark`, {
      method: 'POST',
      headers: { ...authorised(oldToken), 'content-type': 'application/json' },
      body: JSON.stringify({ seat: oldSeat, topic: topic(taskId), field: 'due' }),
    });
    expect(marked.status).toBe(200);
    const seen = async () => {
      const response = await api.request(
        `${PREFIX.person}${key}/live/presence?seat=${observerSeat}&topic=${topic(taskId)}`,
        { headers: authorised(observerToken) },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        seenBy: { personId: string; state: string; field: string | null }[];
      };
    };
    expect((await seen()).seenBy).toContainEqual(
      expect.objectContaining({ personId: first.personId, state: 'changing', field: 'due' }),
    );
    await s.db.admin.execute(
      'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
      [s.business, second.personId, first.personId],
    );
    await pool.withBusiness(s.business, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [taskId]);
    });
    // The delivered invalidation proves the remapped stream passed its recheck as the new person.
    await within(
      2_000,
      () => remapped.heard.some((frame) => frame.event === 'invalidate'),
      'rechecked after remap',
    );
    expect(
      (await seen()).seenBy,
      'the old person has no stream here after the remap',
    ).not.toContainEqual(expect.objectContaining({ personId: first.personId }));
  } finally {
    await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
    await topics.close();
    await pool.close();
    await s.db.drop();
  }
});

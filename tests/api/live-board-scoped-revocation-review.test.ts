// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectListener, taskAccess } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { authorised, createApiFixture, ISSUER, post, tokenFor, type ApiFixture } from './fixture.ts';

let fixture: ApiFixture;
let topics: LiveTopics;

beforeAll(async () => {
  fixture = await createApiFixture('board_scope_review');
  topics = await startLiveTopics(connectListener(fixture.db.appUrl));
});
afterAll(async () => {
  await topics?.close();
  await fixture?.drop();
});

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an open board refetches when one of two task read scopes is revoked',
  async () => {
    const api = composeApi({
      database: fixture.db.app,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      keys: runtimeKeys({ ...fixture.environment }),
      live: { topics, recheckMs: 20 },
    }).app;
    const owner = authorised(await tokenFor(fixture.member.presented.subject));
    const tasks: string[] = [];
    for (const title of ['Revoked task', 'Remaining task']) {
      const made = await post(api, '/api/b/alpha/task/create', {
        operationId: randomUUID(),
        fields: { title },
      }, owner);
      expect(made.status).toBe(200);
      tasks.push(String(made.body['recordId']));
    }
    const reader = await enrol(fixture.db.app, fixture.business, 'Two scoped reads');
    const revoked = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const first = await grantTo(tx, reader, 'read', { kind: 'record', id: tasks[0]! });
      await grantTo(tx, reader, 'read', { kind: 'record', id: tasks[1]! });
      return first;
    });
    const headers = authorised(await tokenFor(reader.presented.subject));
    const before = await fixture.db.app.withBusiness(fixture.business, async (tx) =>
      await taskAccess(tx, reader.personId, tasks[0]!));
    expect(before).toBe('readable');
    const response = await api.request('/api/b/alpha/live', { headers });
    expect(response.status).toBe(200);
    const stream = response.body!.getReader();
    const frames: string[] = [];
    const draining = (async () => {
      for (;;) {
        const frame = await stream.read();
        if (frame.done) return;
        frames.push(new TextDecoder().decode(frame.value));
      }
    })();
    try {
      await expect.poll(() => frames.join('')).toContain('event: resync');
      const initial = frames.join('').match(/event: resync/gu)?.length ?? 0;
      await fixture.db.admin.execute('update public.grants set revoked_at = now() where id = $1', [revoked]);
      const after = await fixture.db.app.withBusiness(fixture.business, async (tx) =>
        await Promise.all(tasks.map(async (id) => await taskAccess(tx, reader.personId, id))));
      expect(after).toEqual(['withheld', 'readable']);
      await expect.poll(() => frames.join('').match(/event: resync/gu)?.length ?? 0, { timeout: 800 })
        .toBeGreaterThan(initial);
      expect(frames.join('')).not.toContain(`data: ${tasks[0]}`);
    } finally {
      await stream.cancel();
      await draining;
    }
  },
  15_000,
);

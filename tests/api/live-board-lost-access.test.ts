// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectListener } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  authorised,
  createApiFixture,
  ISSUER,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';
import { randomUUID } from 'node:crypto';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('live board access changes', () => {
  let fixture: ApiFixture;
  let topics: LiveTopics;
  beforeAll(async () => {
    fixture = await createApiFixture('boardaccess');
    topics = await startLiveTopics(connectListener(fixture.db.appUrl));
  });
  afterAll(async () => {
    await topics?.close();
    await fixture?.drop();
  });

  it.each(['revoked', 'trashed'] as const)(
    'invalidates an open board when a previously visible task is %s while another grant remains',
    async (change) => {
      const api = composeApi({
        database: fixture.db.app,
        admin: fixture.db.admin,
        signIn: testSignIn(ISSUER),
        keys: runtimeKeys({ ...fixture.environment }),
        live: { topics, recheckMs: 20 },
      }).app;
      const owner = authorised(await tokenFor(fixture.member.presented.subject));
      const taskIds: string[] = [];
      for (const title of ['Visible task', 'Remaining grant']) {
        const made = await post(
          api,
          '/api/b/alpha/task/create',
          {
            operationId: randomUUID(),
            fields: { title },
          },
          owner,
        );
        expect(made.status).toBe(200);
        taskIds.push(String(made.body['recordId']));
      }
      const target = taskIds[0]!;
      const reader = await enrol(fixture.db.app, fixture.business, `Board reader ${change}`);
      const grants: string[] = [];
      grants.push(
        await fixture.db.app.withBusiness(
          fixture.business,
          async (tx) => await grantTo(tx, reader, 'read'),
        ),
      );
      await fixture.db.app.withBusiness(
        fixture.business,
        async (tx) => await grantTo(tx, reader, 'write', { kind: 'record', id: taskIds[1]! }),
      );
      const headers = authorised(await tokenFor(reader.presented.subject));
      const before = await post(api, '/api/b/alpha/task/board', { board: null }, headers);
      expect(JSON.stringify(before.body)).toContain(target);
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
        const joined = frames.length;
        if (change === 'revoked') {
          await fixture.db.admin.execute(
            'update public.grants set revoked_at = now() where id = $1',
            [grants[0]],
          );
        } else {
          await fixture.db.admin.execute(
            'update public.records set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = gen_random_uuid() where id = $1',
            [target, fixture.member.actorId],
          );
        }
        const after = await post(api, '/api/b/alpha/task/board', { board: null }, headers);
        expect(after.status).toBe(change === 'revoked' ? 403 : 200);
        expect(JSON.stringify(after.body)).not.toContain(target);
        if (change === 'trashed') expect(JSON.stringify(after.body)).toContain(taskIds[1]);
        await expect
          .poll(() => frames.slice(joined).join(''), { timeout: 500 })
          .toMatch(/event: (resync|invalidate|closed|inbox)/u);
      } finally {
        await stream.cancel();
        await draining;
      }
    },
  );
});

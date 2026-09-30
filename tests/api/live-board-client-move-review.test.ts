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
  fixture = await createApiFixture('board_client_move_review');
  topics = await startLiveTopics(connectListener(fixture.db.appUrl));
});
afterAll(async () => {
  await topics?.close();
  await fixture?.drop();
});

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an open board refetches when its visible task moves to another client',
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
    for (const title of ['Moving task', 'Remaining task']) {
      const made = await post(api, '/api/b/alpha/task/create', {
        operationId: randomUUID(), fields: { title },
      }, owner);
      expect(made.status).toBe(200);
      tasks.push(String(made.body['recordId']));
    }
    const clientA = randomUUID();
    const clientB = randomUUID();
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await tx.query(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where id = $1`,
        [tasks[0], clientA],
      );
    });
    const reader = await enrol(fixture.db.app, fixture.business, 'Client A board reader');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'party', id: clientA });
      await grantTo(tx, reader, 'read', { kind: 'record', id: tasks[1]! });
    });
    const access = async () => await fixture.db.app.withBusiness(fixture.business, async (tx) =>
      await taskAccess(tx, reader.personId, tasks[0]!));
    expect(await access()).toBe('readable');
    const response = await api.request('/api/b/alpha/live', {
      headers: authorised(await tokenFor(reader.presented.subject)),
    });
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
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await tx.query(
          `update public.records set data = data || jsonb_build_object('client', $2::text)
            where id = $1`,
          [tasks[0], clientB],
        );
      });
      expect(await access()).toBe('withheld');
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

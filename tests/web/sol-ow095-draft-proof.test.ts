// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable unicorn/consistent-function-scoping -- a placeholder until the promise sets it
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  createFromDraft,
  emptyDraft,
  keepDraft,
  newAttempt,
  readAttempt,
  saveAttempt,
} from '../../apps/web/src/screens/task/task-draft.ts';
import { createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { store } from './draft-support.tsx';

let fixture: ApiFixture;
let token: string;
beforeAll(async () => {
  fixture = await createApiFixture('solow095draft');
  token = await tokenFor(fixture.member.presented.subject);
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, fixture.member, 'write', WHOLE_BUSINESS, false, 'tag');
    await grantTo(tx, fixture.member, 'write', WHOLE_BUSINESS, false, 'time');
  });
});
afterAll(async () => {
  await fixture?.drop();
});

function deferred() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function clientWith(
  intercept: (
    path: string,
    body: Record<string, unknown>,
    serve: () => Promise<Response>,
  ) => Promise<Response>,
) {
  const api = fixture.compose();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return await intercept(
      path,
      body,
      async () => await api.fetch(new Request(`http://api.test${path}`, { ...init, headers })),
    );
  };
  return new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
}

it('Sol proof, criterion 5: resuming a draft before its first create response arrives logs time only once', async () => {
  const gate = deferred();
  const committed = deferred();
  let creates = 0;
  let taskId = '';
  const client = clientWith(async (path, _body, serve) => {
    const response = await serve();
    if (path.endsWith('/task/create') && ++creates === 1) {
      expect(response.status).toBe(200);
      taskId = String((await response.clone().json()).recordId);
      committed.release();
      await gate.promise;
    }
    return response;
  });
  const storage = store();
  const person = 'alpha:the-signed-in-person';
  const draft = { ...emptyDraft(null), title: 'One task, one time entry', time: '30m' };
  const attempt = newAttempt(randomUUID());
  keepDraft(storage, person, draft, attempt);
  const save = (next: typeof attempt): void => saveAttempt(storage, person, attempt.id, next);
  const first = createFromDraft(client, draft, attempt, save);
  let resumed;
  try {
    await committed.promise;
    const restored = readAttempt(storage, person);
    expect(restored).not.toBeNull();
    if (restored === null) throw new Error('The pending attempt was not stored.');
    resumed = await createFromDraft(client, draft, restored, save);
  } finally {
    gate.release();
    await first;
  }
  expect(resumed).toMatchObject({ kind: 'created', missed: [] });
  const entries = await fixture.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.time_entries where task_id = $1',
    [taskId],
  );
  expect(
    entries[0]?.n,
    'Both invocations minted a different id for the same draft time part.',
  ).toBe('1');
});

it('Sol proof, criterion 5: a lost tag-create response replays the same tag operation when tag.list is refused', async () => {
  let lose = true;
  const tagIds: unknown[] = [];
  const client = clientWith(async (path, body, serve) => {
    const response = await serve();
    if (path.endsWith('/tag/list')) {
      expect(response.status).toBe(403);
      expect((await response.clone().json()).code).toBe('SCOPE_NOT_GRANTED');
    }
    if (path.endsWith('/tag/create')) {
      tagIds.push(body['operationId']);
      if (lose) {
        lose = false;
        expect(response.status).toBe(200);
        throw new TypeError('The committed tag response was lost.');
      }
    }
    return response;
  });
  const draft = { ...emptyDraft(null), title: 'Keep the tag on retry', tags: ['Sol retry tag'] };
  let attempt = newAttempt(randomUUID());
  const save = (next: typeof attempt): void => {
    attempt = next;
  };
  expect(await createFromDraft(client, draft, attempt, save)).toMatchObject({ kind: 'unknown' });
  const retry = await createFromDraft(client, draft, attempt, save);
  expect(retry, `tag.create ids: ${JSON.stringify(tagIds)}`).toMatchObject({
    kind: 'created',
    missed: [],
  });
  const tags = await fixture.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.task_tags t join public.tags g
       on g.business_id = t.business_id and g.id = t.tag_id where g.name = 'Sol retry tag'`,
  );
  expect(tags[0]?.n).toBe('1');
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  TASK,
  PERSON,
  OTHER,
  AGENT,
  TITLE,
  NAME,
  assignmentWorld,
  assignmentApp,
  chooseAssignment,
  retryAssignment,
  copied,
  expectHeldCopy,
  recoveryCopies,
  deferredAnswer,
  assignmentAnswer,
} from './p05-assignment-recovery-support.tsx';

for (const surface of ['page', 'panel', 'board'] as const) {
  it(
    'actual App ' +
      surface +
      ' retries the original committed assignment after a reread exactly once',
    async () => {
      const world = assignmentWorld();
      const app = await assignmentApp(world, undefined, surface);
      await chooseAssignment(app, surface, PERSON);
      const original = world.writes[0];
      expect(original?.body).toMatchObject({
        recordId: TASK,
        fields: { assignee: PERSON },
        expectedRevision: 4,
      });
      expect(world.applications).toHaveLength(1);
      expectHeldCopy(app.storage, original!);
      if (surface === 'page') {
        await app.view.click('[data-refresh="task"]');
        await app.tick();
      }
      await retryAssignment(app);
      expect(world.writes).toHaveLength(2);
      expect(world.writes[1]).toEqual(original);
      expect(world.applications).toHaveLength(1);
      expect(
        recoveryCopies(app.storage).some((raw) =>
          raw?.includes(String(original?.body['operationId'])),
        ),
      ).toBe(false);
    },
  );

  it(
    'actual App ' +
      surface +
      ' own-agent retry freezes delegation, revision and operation identity',
    async () => {
      const world = assignmentWorld();
      const app = await assignmentApp(world, undefined, surface);
      await chooseAssignment(app, surface, AGENT, true);
      const original = world.writes[0];
      expect(original?.body).toMatchObject({
        recordId: TASK,
        fields: { agent: AGENT },
        expectedRevision: 4,
      });
      world.advance();
      await retryAssignment(app);
      expect(world.writes).toHaveLength(2);
      expect(world.writes[1]).toEqual(original);
      expect(world.applications).toHaveLength(1);
    },
  );
}

it('clearing a person is an exact null assignment, then a settled new choice receives a new ID', async () => {
  const world = assignmentWorld('stored', true);
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', null);
  const original = world.writes[0];
  expect(original?.body['fields']).toEqual({ assignee: null });
  await retryAssignment(app);
  await chooseAssignment(app, 'page', OTHER);
  expect(world.writes).toHaveLength(3);
  expect(world.writes[1]).toEqual(original);
  expect(world.writes[2]?.body['operationId']).not.toBe(original?.body['operationId']);
  expect(world.writes[2]?.body['fields']).toEqual({ assignee: OTHER });
  expect(world.applications).toHaveLength(2);
});

for (const loss of ['stored', 'unreached'] as const) {
  it(
    'fresh module App recovers a ' + loss + ' assignment without automatic replay or a replacement',
    async () => {
      const world = assignmentWorld(loss);
      const first = await assignmentApp(world);
      await chooseAssignment(first, 'page', PERSON);
      const original = world.writes[0];
      expectHeldCopy(first.storage, original!);
      const storage = copied(first.storage);
      await first.view.unmount();
      const before = world.writes.length;
      const next = await assignmentApp(world, storage);
      expect(world.writes).toHaveLength(before);
      await retryAssignment(next);
      expect(world.writes).toHaveLength(before + 1);
      expect(world.writes.at(-1)).toEqual(original);
      expect(world.applications).toHaveLength(1);
    },
  );
}

it('unknown-to-withheld assignment keeps custody through denied reads and fresh realm until authoritative replay', async () => {
  const world = assignmentWorld();
  const first = await assignmentApp(world);
  await chooseAssignment(first, 'page', PERSON);
  const original = world.writes[0];
  world.denyWrites(true);
  await retryAssignment(first);
  expect(world.writes[1]).toEqual(original);
  expect(first.view.text()).toContain('SCOPE_NOT_GRANTED');
  expectHeldCopy(first.storage, original!);
  world.denyReads(true);
  const storage = copied(first.storage);
  await first.view.unmount();
  const denied = await assignmentApp(world, storage);
  expect(denied.view.text()).not.toContain(TITLE);
  expect(denied.view.text()).not.toContain(NAME);
  expect(world.writes).toHaveLength(2);
  expectHeldCopy(storage, original!);
  await denied.view.unmount();
  world.denyReads(false);
  world.denyWrites(false);
  world.advance();
  const renewed = await assignmentApp(world, copied(storage));
  expect(world.writes).toHaveLength(2);
  await retryAssignment(renewed);
  expect(world.writes).toHaveLength(3);
  expect(world.writes[2]).toEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('withdrawn assignee vocabulary hides labels while original admitted assignment remains retryable', async () => {
  const world = assignmentWorld();
  const first = await assignmentApp(world);
  await chooseAssignment(first, 'page', PERSON);
  const original = world.writes[0];
  const storage = copied(first.storage);
  await first.view.unmount();
  world.denyVocabulary();
  const next = await assignmentApp(world, storage);
  expect(next.view.find('main select[aria-label="Assignee"]')).toBeNull();
  await retryAssignment(next);
  expect(world.writes[1]).toEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('same-owner transport renewal preserves a busy assignment and fences its old response', async () => {
  const world = assignmentWorld();
  const older = deferredAnswer();
  world.delayWrite(older.promise);
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', PERSON);
  const original = world.writes[0];
  expectHeldCopy(app.storage, original!);
  await app.renderFetch((input, init) => world.fetch(input, init));
  await app.tick();
  await retryAssignment(app);
  expect(world.writes[1]).toEqual(original);
  expect(world.applications).toHaveLength(1);
  await app.act(() => older.release(assignmentAnswer()));
  expect(world.writes).toHaveLength(2);
  expect(
    recoveryCopies(app.storage).some((raw) => raw?.includes(String(original?.body['operationId']))),
  ).toBe(false);
});

it('sign-out retires the owner and a delayed assignment cannot restore private custody', async () => {
  const world = assignmentWorld();
  const delayed = deferredAnswer();
  world.delayWrite(delayed.promise);
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', PERSON);
  const original = world.writes[0];
  expectHeldCopy(app.storage, original!);
  await app.view.click('.appbar .who__trigger');
  await app.view.click('.who__menu button[role="menuitem"]');
  expect(app.view.find('#signin-email')).not.toBeNull();
  expect(
    recoveryCopies(app.storage).some((raw) => raw?.includes(String(original?.body['operationId']))),
  ).toBe(false);
  await app.act(() => delayed.release(assignmentAnswer()));
  expect(app.view.text()).not.toContain(TITLE);
  expect(app.view.text()).not.toContain(NAME);
  expect(
    recoveryCopies(app.storage).some((raw) => raw?.includes(String(original?.body['operationId']))),
  ).toBe(false);
  expect(world.writes).toHaveLength(1);
});

it('Refresh unmounts the control while success settles, then the authorised read has no stale retry', async () => {
  const world = assignmentWorld('none');
  const post = deferredAnswer();
  const read = deferredAnswer();
  world.delayWrite(post.promise);
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', PERSON);
  world.delayRead(read.promise);
  await app.view.click('[data-refresh="task"]');
  expect(app.view.find('main select[aria-label="Assignee"]')).toBeNull();
  await app.act(() => post.release(assignmentAnswer()));
  world.delayRead(null);
  await app.act(() =>
    read.release(
      new Response(JSON.stringify({ ok: true, task: world.task(), states: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  await app.tick();
  expect(app.view.find('main select[aria-label="Assignee"]')).toHaveProperty('value', PERSON);
  expect(world.writes).toHaveLength(1);
  expect(world.applications).toHaveLength(1);
  expect(
    app.view
      .all('button')
      .some((button) => /retry.*assignment|assignment.*retry/iu.test(button.textContent ?? '')),
  ).toBe(false);
});

it('a different selection cannot replace an unknown assignment or erase an unrelated comment draft', async () => {
  const world = assignmentWorld();
  const app = await assignmentApp(world);
  await app.view.type('#comment-body', 'Unsent unrelated comment remains mine');
  await chooseAssignment(app, 'page', PERSON);
  const original = world.writes[0];
  const control = app.view.find('main select[aria-label="Assignee"]');
  expect(control).toBeInstanceOf(HTMLSelectElement);
  if (!(control as HTMLSelectElement).disabled) await chooseAssignment(app, 'page', OTHER);
  expect(world.writes).toHaveLength(1);
  expectHeldCopy(app.storage, original!);
  await app.view.click('[data-refresh="task"]');
  await app.tick();
  expect(app.view.find('#comment-body')).toHaveProperty(
    'value',
    'Unsent unrelated comment remains mine',
  );
  await retryAssignment(app);
  expect(world.writes[1]).toEqual(original);
  expect(world.applications).toHaveLength(1);
  expect(app.view.find('#comment-body')).toHaveProperty(
    'value',
    'Unsent unrelated comment remains mine',
  );
});

it('initial authority refusal is shown as refusal and does not offer an unknown replay', async () => {
  const world = assignmentWorld('none');
  world.denyWrites(true);
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', PERSON);
  expect(world.writes).toHaveLength(1);
  expect(world.applications).toHaveLength(0);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  const retry = app.view
    .all('button')
    .find((button) => /retry.*assignment|assignment.*retry/iu.test(button.textContent ?? ''));
  expect(retry === undefined || (retry as HTMLButtonElement).disabled).toBe(true);
  expect(app.view.find('main select[aria-label="Assignee"]')).toHaveProperty('disabled', true);
});

it('stale refusal settles an unreached original before a new choice gets a fresh identity', async () => {
  const world = assignmentWorld('unreached');
  const app = await assignmentApp(world);
  await chooseAssignment(app, 'page', PERSON);
  const original = world.writes[0];
  world.advance();
  await retryAssignment(app);
  expect(world.writes[1]).toEqual(original);
  expect(world.applications).toHaveLength(0);
  expect(app.view.text()).toContain('VERSION_STALE');
  expect(
    recoveryCopies(app.storage).some((raw) => raw?.includes(String(original?.body['operationId']))),
  ).toBe(false);
  await chooseAssignment(app, 'page', OTHER);
  expect(world.writes).toHaveLength(3);
  expect(world.writes[2]?.body['operationId']).not.toBe(original?.body['operationId']);
  expect(world.writes[2]?.body).toMatchObject({ fields: { assignee: OTHER }, expectedRevision: 5 });
  expect(world.applications).toHaveLength(1);
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import {
  PERSON,
  OTHER,
  assignmentWorld,
  assignmentApp,
  chooseAssignment,
  retryAssignment,
  expectHeldCopy,
  recoveryCopies,
  copied,
} from './p05-assignment-recovery-support.tsx';

it('failed pre-send persistence sends no assignment and explicit retry keeps the same durable identity', async () => {
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  let blocked = false;
  storage.setItem = (name, value) => {
    if (blocked) throw new Error('Recovery persistence blocked');
    set(name, value);
  };
  const world = assignmentWorld('none');
  const app = await assignmentApp(world, storage);
  blocked = true;
  await chooseAssignment(app, 'page', PERSON);
  expect(world.writes).toHaveLength(0);
  expect(world.applications).toHaveLength(0);
  expect(app.view.text()).toMatch(/could not.*kept|could not.*stored|unable.*keep/iu);
  blocked = false;
  await retryAssignment(app);
  expect(world.writes).toHaveLength(1);
  expect(world.applications).toHaveLength(1);
});

it('confirmed assignment with failed durable cleanup retries cleanup only and never re-applies', async () => {
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  const remove = storage.removeItem.bind(storage);
  let cleanupBlocked = false;
  storage.setItem = (name, value) => {
    if (cleanupBlocked) throw new Error('Recovery cleanup blocked');
    set(name, value);
  };
  storage.removeItem = (name) => {
    if (cleanupBlocked) throw new Error('Recovery removal blocked');
    remove(name);
  };
  const world = assignmentWorld();
  const app = await assignmentApp(world, storage);
  await chooseAssignment(app, 'page', PERSON);
  const original = world.writes[0];
  expectHeldCopy(storage, original!);
  const baseFetch = world.fetch;
  await app.renderFetch(async (input, init) => {
    const response = await baseFetch(input, init);
    if (String(input).endsWith('/task/assign') && response.ok) cleanupBlocked = true;
    return response;
  });
  await app.tick();
  await retryAssignment(app);
  expect(world.writes).toHaveLength(2);
  expect(world.applications).toHaveLength(1);
  expect(app.view.text()).toMatch(/could not.*clear|could not.*kept|cleanup/iu);
  await retryAssignment(app);
  expect(world.writes).toHaveLength(2);
  cleanupBlocked = false;
  await retryAssignment(app);
  expect(world.writes).toHaveLength(2);
  expect(
    recoveryCopies(storage).some((raw) => raw?.includes(String(original?.body['operationId']))),
  ).toBe(false);
  await chooseAssignment(app, 'page', OTHER);
  expect(world.writes).toHaveLength(3);
  expect(world.writes[2]?.body['operationId']).not.toBe(original?.body['operationId']);
});

it('another fresh owner cannot draw or retry the earlier owner assignment', async () => {
  const world = assignmentWorld();
  const first = await assignmentApp(world);
  await chooseAssignment(first, 'page', PERSON);
  const original = world.writes[0];
  expectHeldCopy(first.storage, original!);
  const storage = copied(first.storage);
  await first.view.unmount();
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ businessKey: 'alpha', email: 'different-owner@example.test' }),
  );
  const next = await assignmentApp(world, storage);
  expect(world.writes).toHaveLength(1);
  expect(
    next.view
      .all('button')
      .some((button) => /retry.*assignment|assignment.*retry/iu.test(button.textContent ?? '')),
  ).toBe(false);
  await chooseAssignment(next, 'page', OTHER);
  expect(world.writes).toHaveLength(2);
  expect(world.writes[1]?.body['operationId']).not.toBe(original?.body['operationId']);
  expect(world.writes[1]?.body['fields']).toEqual({ assignee: OTHER });
});

it('another fresh business has no old assignment recovery or automatic dispatch', async () => {
  const world = assignmentWorld();
  const first = await assignmentApp(world);
  await chooseAssignment(first, 'page', PERSON);
  const original = world.writes[0];
  expectHeldCopy(first.storage, original!);
  const storage = copied(first.storage);
  await first.view.unmount();
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ businessKey: 'beta', email: 'draft-entry@example.test' }),
  );
  const next = await assignmentApp(world, storage);
  expect(world.writes).toHaveLength(1);
  expect(
    next.view
      .all('button')
      .some((button) => /retry.*assignment|assignment.*retry/iu.test(button.textContent ?? '')),
  ).toBe(false);
  expect(next.view.find('main select[aria-label="Assignee"]')).toBeNull();
});
